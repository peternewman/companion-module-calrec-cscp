import {
	CalrecClient,
	type CalrecClientEvents,
	channelLevelToDb,
	ConnectionState,
	dbToChannelLevel,
	mainLevelToDb,
} from '@bitfocusas/calrec-cscp'
import { InstanceStatus, type LogLevel } from '@companion-module/base'
import type { CalrecConfig } from './config.js'
import {
	CHANNEL_FADER_MAX_DB,
	CHANNEL_FADER_MIN_DB,
	COMMAND_RESPONSE_TIMEOUT_MS,
	DB_DISPLAY_SNAP_DB,
	DEFAULT_MAX_FADER_COUNT,
	FADER_LEVEL_RATE_MS,
	FADER_LEVEL_SETTLE_MS,
	HEARTBEAT_INTERVAL_MS,
	HEARTBEAT_MAX_MISSES,
	INITIAL_FLOOD_MAX_MS,
	INITIAL_FLOOD_POLL_MS,
	INITIAL_FLOOD_QUIET_MS,
	MAX_MAIN_COUNT,
	MAX_PROTOCOL_LEVEL,
	MIN_PROTOCOL_LEVEL,
} from './constants.js'
import type { ToggleState } from './options.js'
import { clamp, clampToInteger, describeError, formatDb, sanitizeFaderLabel, sleep } from './util.js'
import { faderVariableId, type VariableValue } from './variables.js'

/** What the API needs from the Companion instance. */
export interface CalrecApiHost {
	log(level: LogLevel, message: string): void
	updateStatus(status: InstanceStatus, message?: string | null): void
	checkFeedbacks(...feedbackTypes: string[]): void
	/** Publish a Companion variable if its value changed. */
	setVariable(variableId: string, value: VariableValue): void
	/** The effective fader count changed, so definitions need rebuilding. */
	onFaderCountChanged(faderCount: number): void
}

/** Everything the module caches about one channel fader. */
interface FaderState {
	level: number
	/** Numeric dB used for relative steps (avoids level↔dB round-trip drift). */
	levelDbValue: number
	isCut: boolean
	/** null until the desk pushes a PFL change; it never reports PFL state on request. */
	isPfl: boolean | null
	label: string
	isLeftToBoth: boolean
	isRightToBoth: boolean
}

/**
 * Resolve an on/off/toggle selection against the last known state.
 *
 * A `null` current state means the console has never reported one, which toggles to on —
 * the same result as toggling from a known-off state, so an untracked control still
 * behaves predictably on first press.
 */
function resolveToggle(state: ToggleState, current: boolean | null): boolean {
	return state === 'toggle' ? current !== true : state === 'on'
}

/**
 * Latest-wins writer for channel fader levels.
 *
 * The library queues every `setFaderLevel` call, so a rotary burst would otherwise send a
 * backlog of stale values. This keeps one target per fader and chases it until it sticks.
 * After a successful write the target stays visible briefly so inbound echoes can snap the
 * displayed dB to the intended value (relative 1 dB steps stay clean).
 */
class FaderLevelWriter {
	private readonly targets = new Map<number, { level: number; desiredDb: number }>()
	private readonly busy = new Set<number>()
	private readonly settleTimers = new Map<number, ReturnType<typeof setTimeout>>()
	/** Bumped by `cancelAll` so an in-flight write abandons its loop. */
	private epoch = 0

	constructor(
		private readonly client: CalrecClient,
		private readonly log: (level: LogLevel, message: string) => void,
	) {}

	/** The dB value this fader is currently being driven towards, or undefined when idle. */
	getDesiredDb(faderId: number): number | undefined {
		return this.targets.get(faderId)?.desiredDb
	}

	write(faderId: number, level: number, desiredDb: number): void {
		this.clearSettle(faderId)
		this.targets.set(faderId, { level, desiredDb })
		void this.drain(faderId)
	}

	cancelAll(): void {
		this.epoch++
		for (const timer of this.settleTimers.values()) clearTimeout(timer)
		this.settleTimers.clear()
		this.targets.clear()
	}

	private async drain(faderId: number): Promise<void> {
		if (this.busy.has(faderId)) return
		this.busy.add(faderId)
		const epoch = this.epoch

		try {
			while (this.epoch === epoch) {
				const target = this.targets.get(faderId)
				if (!target) return

				const sentLevel = target.level
				try {
					await this.client.setFaderLevel(faderId, sentLevel)
					// this.log(
					// 	'debug',
					// 	`Set fader ${faderId + 1} level to ${sentLevel} (${formatDb(target.desiredDb)} dB)`,
					// )
				} catch (error: unknown) {
					this.log('error', `Failed to set fader ${faderId + 1} level: ${describeError(error)}`)
					this.targets.delete(faderId)
					return
				}

				if (this.epoch !== epoch) return

				// Target moved while the write was in flight — chase it.
				const current = this.targets.get(faderId)
				if (current && current.level !== sentLevel) continue

				this.settleTimers.set(
					faderId,
					setTimeout(() => {
						this.settleTimers.delete(faderId)
						if (this.targets.get(faderId)?.level === sentLevel) this.targets.delete(faderId)
					}, FADER_LEVEL_SETTLE_MS),
				)
				return
			}
		} finally {
			this.busy.delete(faderId)
		}
	}

	private clearSettle(faderId: number): void {
		const timer = this.settleTimers.get(faderId)
		if (timer !== undefined) {
			clearTimeout(timer)
			this.settleTimers.delete(faderId)
		}
	}
}

export class CalrecApi {
	private readonly faderStates = new Map<number, FaderState>()

	private config: CalrecConfig | null = null
	private client: CalrecClient | null = null
	private levelWriter: FaderLevelWriter | null = null

	/** Bumped on reconnect/teardown so an in-flight ready sync can abort. */
	private connectionGeneration = 0
	/** From console info when available; used to cap the configured maxFaderCount. */
	private detectedFaderCount: number | null = null
	/** After ready sync dumps full state once; live change logs only fire after that. */
	private initialSyncComplete = false
	/** Last inbound push during the connect flood; used to detect when it has settled. */
	private lastFloodActivityAt = 0

	constructor(private readonly host: CalrecApiHost) {}

	// --- Lifecycle -----------------------------------------------------------

	/** Store the configuration used by the next {@link connect} and by fader-count maths. */
	configure(config: CalrecConfig): void {
		this.config = config
	}

	/** Open a connection using the stored configuration. Does not wait for the socket. */
	connect(): void {
		const config = this.config
		if (!config) {
			this.host.log('error', 'Cannot connect before the module has been configured')
			return
		}

		const client = new CalrecClient(
			{
				host: config.host,
				port: config.port,
				maxFaderCount: config.maxFaderCount ?? DEFAULT_MAX_FADER_COUNT,
				maxMainCount: MAX_MAIN_COUNT,
			},
			{
				commandResponseTimeoutMs: COMMAND_RESPONSE_TIMEOUT_MS,
				faderLevelRateMs: FADER_LEVEL_RATE_MS,
				heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
				heartbeatMaxMisses: HEARTBEAT_MAX_MISSES,
			},
		)
		this.client = client
		this.levelWriter = new FaderLevelWriter(client, (level, message) => this.host.log(level, message))
		this.registerEventListeners(client)

		// Not awaited: a TCP connect to an unreachable host can outlast Companion's init timeout.
		void client.connect().catch((error: unknown) => {
			if (this.client !== client) return
			this.host.updateStatus(InstanceStatus.ConnectionFailure, 'Failed to connect')
			this.host.log('error', `Connection failed: ${describeError(error)}`)
		})
	}

	/**
	 * Detach and close the active client, drop its queued writes, and forget everything
	 * cached from it so a later connect never serves stale state.
	 */
	disconnect(): void {
		this.connectionGeneration++
		this.levelWriter?.cancelAll()
		this.levelWriter = null

		const client = this.client
		if (client) {
			// Cleared first so a late event from this client is rejected by the listener guard.
			this.client = null
			client.removeAllListeners()
			void client.disconnect()
		}

		this.faderStates.clear()
		this.detectedFaderCount = null
		this.initialSyncComplete = false
		this.lastFloodActivityAt = 0
	}

	// --- Cached console state ------------------------------------------------

	/** Effective fader count: the configured maximum, capped by the console's own count. */
	getMaxFaderCount(): number {
		const configured = this.config?.maxFaderCount ?? DEFAULT_MAX_FADER_COUNT
		if (this.detectedFaderCount !== null && this.detectedFaderCount > 0) {
			return Math.min(configured, this.detectedFaderCount)
		}
		return configured
	}

	/** Last known cut state. A fader the console has not reported reads as uncut. */
	isFaderCut(faderId: number): boolean {
		return this.faderStates.get(faderId)?.isCut ?? false
	}

	/** Last known PFL state, or `null` while the console has never reported one. */
	getFaderPfl(faderId: number): boolean | null {
		return this.faderStates.get(faderId)?.isPfl ?? null
	}

	/** Last known left to both state. A fader the console has not reported reads as off. */
	getFaderLeftToBoth(faderId: number): boolean {
		return this.faderStates.get(faderId)?.isLeftToBoth ?? false
	}

	/** Last known right to both state. A fader the console has not reported reads as off. */
	getFaderRightToBoth(faderId: number): boolean {
		return this.faderStates.get(faderId)?.isRightToBoth ?? false
	}


	// --- Outbound commands ---------------------------------------------------

	/** Queue an absolute protocol-level write; variables update when the console echoes. */
	setFaderLevel(faderId: number, level: number): void {
		const clamped = clampToInteger(level, MIN_PROTOCOL_LEVEL, MAX_PROTOCOL_LEVEL)
		this.queueLevelWrite(faderId, clamped, channelLevelToDb(clamped))
	}

	/** Queue an absolute dB write; variables update when the console echoes. */
	setFaderLevelDb(faderId: number, levelDb: number): void {
		const desiredDb = clamp(levelDb, CHANNEL_FADER_MIN_DB, CHANNEL_FADER_MAX_DB)
		this.queueLevelWrite(faderId, dbToChannelLevel(desiredDb), desiredDb)
	}

	/**
	 * Relative level change. Accumulates in dB space (not raw level) so 1 dB steps stay on
	 * integer boundaries instead of drifting through level↔dB quantisation.
	 */
	adjustFaderLevelDb(faderId: number, deltaDb: number): void {
		this.setFaderLevelDb(faderId, this.getTargetDb(faderId) + deltaDb)
	}

	/** Set cut on the console, optimistically reflecting the new state locally. */
	async setFaderCut(faderId: number, state: ToggleState): Promise<void> {
		const client = this.requireClient(`cut for fader ${faderId + 1}`)
		if (!client) return

		const isCut = resolveToggle(state, this.isFaderCut(faderId))
		try {
			await client.setFaderCut(faderId, isCut)
			// Optimistic: the console may only ACK without echoing a change event.
			this.applyFaderCut(faderId, isCut)
			// this.host.log('debug', `Set fader ${faderId + 1} cut to ${isCut}`)
		} catch (error: unknown) {
			this.host.log('error', `Failed to set fader ${faderId + 1} cut: ${describeError(error)}`)
		}
	}

	/** Set PFL on the console, optimistically reflecting the new state locally. */
	async setFaderPfl(faderId: number, state: ToggleState): Promise<void> {
		const client = this.requireClient(`PFL for fader ${faderId + 1}`)
		if (!client) return

		const isPfl = resolveToggle(state, this.getFaderPfl(faderId))
		try {
			await client.setFaderPfl(faderId, isPfl)
			// Optimistic: the console may only ACK without echoing a change event.
			this.applyFaderPfl(faderId, isPfl)
			// this.host.log('debug', `Set fader ${faderId + 1} PFL to ${isPfl}`)
		} catch (error: unknown) {
			this.host.log('error', `Failed to set fader ${faderId + 1} PFL: ${describeError(error)}`)
		}
	}

	/**
	 * Set PFL on a main fader.
	 *
	 * Main PFL state is not cached (the module does not subscribe to `mainPflChange`), so a
	 * toggle always resolves to on. Prefer the explicit on/off choices for mains.
	 */
	async setMainFaderPfl(mainId: number, state: ToggleState): Promise<void> {
		const client = this.requireClient(`PFL for main fader ${mainId + 1}`)
		if (!client) return

		const isPfl = resolveToggle(state, null)
		try {
			await client.setMainFaderPfl(mainId, isPfl)
			// this.host.log('debug', `Set main fader ${mainId + 1} PFL to ${isPfl}`)
		} catch (error: unknown) {
			this.host.log('error', `Failed to set main fader ${mainId + 1} PFL: ${describeError(error)}`)
		}
	}

	/** Set a main fader from a protocol level, converted through the main-fader curve. */
	async setMainFaderLevel(mainId: number, level: number): Promise<void> {
		const clamped = clampToInteger(level, MIN_PROTOCOL_LEVEL, MAX_PROTOCOL_LEVEL)
		await this.setMainFaderLevelDb(mainId, mainLevelToDb(clamped))
	}

	async setMainFaderLevelDb(mainId: number, levelDb: number): Promise<void> {
		const client = this.requireClient(`level for main fader ${mainId + 1}`)
		if (!client) return

		try {
			await client.setMainFaderLevelDb(mainId, levelDb)
			// this.host.log('debug', `Set main fader ${mainId + 1} level to ${formatDb(levelDb)} dB`)
		} catch (error: unknown) {
			this.host.log('error', `Failed to set main fader ${mainId + 1} level: ${describeError(error)}`)
		}
	}

	private requireClient(description: string): CalrecClient | null {
		if (this.client) return this.client
		this.host.log('warn', `Ignoring ${description}: not connected to a console`)
		return null
	}

	private queueLevelWrite(faderId: number, level: number, desiredDb: number): void {
		if (!this.levelWriter) {
			this.host.log('warn', `Ignoring level for fader ${faderId + 1}: not connected to a console`)
			return
		}
		this.levelWriter.write(faderId, level, desiredDb)
	}

	/** dB a relative step starts from: the in-flight target, else the last settled value. */
	private getTargetDb(faderId: number): number {
		return (
			this.levelWriter?.getDesiredDb(faderId) ??
			this.faderStates.get(faderId)?.levelDbValue ??
			CHANNEL_FADER_MIN_DB
		)
	}

	// --- Events --------------------------------------------------------------

	private registerEventListeners(client: CalrecClient): void {
		// Every handler is guarded so a client that has since been replaced (reconnect,
		// config change) can never write into the current connection's state.
		const on = <K extends keyof CalrecClientEvents>(
			event: K,
			handler: (...args: Parameters<CalrecClientEvents[K]>) => void,
		): void => {
			const guarded = (...args: Parameters<CalrecClientEvents[K]>): void => {
				if (this.client !== client) return
				handler(...args)
			}
			// TS cannot prove a generic rest signature satisfies the mapped listener type.
			client.on(event, guarded as CalrecClientEvents[K])
		}

		on('connect', () => {
			this.host.log('info', 'Connected to Calrec console')
			this.host.updateStatus(InstanceStatus.Ok)
		})

		on('disconnect', () => {
			this.host.log('warn', 'Disconnected from Calrec console')
			this.connectionGeneration++
			this.levelWriter?.cancelAll()
			this.host.updateStatus(InstanceStatus.Disconnected)
		})

		on('error', (error) => {
			this.host.log('error', `Calrec client error: ${error.message}`)
			this.host.updateStatus(InstanceStatus.ConnectionFailure, error.message)
		})

		on('connectionStateChange', (state) => {
			this.host.log('debug', `Connection state: ${state}`)
			if (state === ConnectionState.RECONNECTING) {
				this.host.updateStatus(InstanceStatus.Disconnected, 'Reconnecting')
			}
		})

		on('ready', () => {
			void this.handleReady(client)
		})

		// Flood activity only — nothing in this module consumes aux availability yet.
		on('availableAuxesChange', () => {
			this.noteFloodActivity()
		})

		on('faderLevelChange', (faderId, level) => this.handleFaderLevelChange(faderId, level))

		on('faderCutChange', (faderId, isCut) => {
			this.noteFloodActivity()
			// this.logLiveChange(`Fader ${faderId + 1} cut state changed to ${isCut}`)
			this.applyFaderCut(faderId, isCut)
		})

		on('faderPflChange', (faderId, isPfl) => {
			this.noteFloodActivity()
			// this.logLiveChange(`Fader ${faderId + 1} PFL state changed to ${isPfl}`)
			this.applyFaderPfl(faderId, isPfl)
		})

		on('faderLabelChange', (faderId, label) => {
			this.noteFloodActivity()
			this.applyFaderLabel(faderId, sanitizeFaderLabel(label))
		})

		on('stereoImageChange', (faderId, image) => {
			this.noteFloodActivity()
			// this.logLiveChange(`Fader ${faderId + 1} stereo image state changed to ${image.leftToBoth}, ${image.rightToBoth}`)
			this.applyFaderStereoImage(faderId, image.leftToBoth, image.rightToBoth)
		})
	}

	// --- Ready sync ----------------------------------------------------------

	private async handleReady(client: CalrecClient): Promise<void> {
		const generation = this.connectionGeneration
		const isCurrent = (): boolean => this.client === client && this.connectionGeneration === generation

		this.initialSyncComplete = false
		// Listeners may already have recorded flood activity before `ready` fired.
		if (this.lastFloodActivityAt === 0) this.lastFloodActivityAt = Date.now()
		this.host.log('info', 'Calrec console is ready; waiting for console state')

		await this.waitForInitialFlood(client, isCurrent)
		if (!isCurrent()) return

		await this.resolveFaderCount(client, isCurrent)
		if (!isCurrent()) return

		// One feedback pass after the flood instead of per-fader storms.
		this.host.checkFeedbacks('fader_cut_state', 'fader_pfl_state')
		this.initialSyncComplete = true
		this.host.log('info', `Ready sync completed (${this.faderStates.size} fader(s) from console)`)
	}

	/**
	 * The desk pushes current fader state on connect. Wait until that burst goes quiet
	 * rather than re-reading every fader over the command queue.
	 */
	private async waitForInitialFlood(client: CalrecClient, isCurrent: () => boolean): Promise<void> {
		const startedAt = Date.now()

		while (isCurrent()) {
			this.applyCachedConsoleInfo(client)

			const now = Date.now()
			if (this.faderStates.size > 0 && now - this.lastFloodActivityAt >= INITIAL_FLOOD_QUIET_MS) return
			if (now - startedAt >= INITIAL_FLOOD_MAX_MS) {
				if (this.faderStates.size === 0) {
					this.host.log(
						'warn',
						`No console state within ${INITIAL_FLOOD_MAX_MS}ms; continuing with empty cache`,
					)
				}
				return
			}

			await sleep(INITIAL_FLOOD_POLL_MS)
		}
	}

	/** Prefer the unsolicited console-info push, then one explicit read, then inference. */
	private async resolveFaderCount(client: CalrecClient, isCurrent: () => boolean): Promise<void> {
		this.applyCachedConsoleInfo(client)
		if (this.detectedFaderCount !== null) return

		try {
			const info = await client.getConsoleInfo()
			if (!isCurrent()) return
			if (info?.maxFaders) {
				this.applyDetectedFaderCount(info.maxFaders)
				return
			}
		} catch (error: unknown) {
			this.host.log(
				'warn',
				`Could not read console fader count, using configured max ${this.getMaxFaderCount()}: ${describeError(error)}`,
			)
		}

		if (!isCurrent() || this.faderStates.size === 0) return

		const inferredCount = Math.max(...this.faderStates.keys()) + 1
		this.host.log('debug', `Inferring fader count ${inferredCount} from console flood`)
		this.applyDetectedFaderCount(inferredCount)
	}

	private applyCachedConsoleInfo(client: CalrecClient): void {
		const info = client.getState().consoleInfo
		if (info?.maxFaders) this.applyDetectedFaderCount(info.maxFaders)
	}

	private applyDetectedFaderCount(count: number): void {
		if (count < 1 || this.detectedFaderCount === count) return

		this.detectedFaderCount = count
		const effective = this.getMaxFaderCount()
		const configured = this.config?.maxFaderCount ?? DEFAULT_MAX_FADER_COUNT
		this.host.log('info', `Using ${effective} faders (console=${count}, configured max=${configured})`)
		this.host.onFaderCountChanged(effective)
	}

	/** Bump the connect-flood quiet timer while initial sync is still open. */
	private noteFloodActivity(): void {
		if (!this.initialSyncComplete) this.lastFloodActivityAt = Date.now()
	}

	// /** Per-change debug logging, suppressed during the noisy connect flood. */
	// private logLiveChange(message: string): void {
	// 	if (this.initialSyncComplete) this.host.log('debug', message)
	// }

	// --- Inbound state -------------------------------------------------------

	private handleFaderLevelChange(faderId: number, level: number): void {
		this.noteFloodActivity()

		const echoedDb = channelLevelToDb(level)
		const targetDb = this.levelWriter?.getDesiredDb(faderId)
		// While Companion is driving this fader, prefer the intended dB so 1 dB steps stay
		// clean even when the library curve and the desk display disagree by a tenth.
		const displayDb =
			targetDb !== undefined && Math.abs(echoedDb - targetDb) <= DB_DISPLAY_SNAP_DB ? targetDb : echoedDb

		// this.logLiveChange(`Fader ${faderId + 1} level changed to ${level} (${formatDb(displayDb)} dB)`)
		this.applyFaderLevel(faderId, level, displayDb)
	}

	private applyFaderLevel(faderId: number, level: number, levelDbValue: number): void {
		const state = this.getOrInitFaderState(faderId)
		state.level = level
		state.levelDbValue = levelDbValue
		this.host.setVariable(faderVariableId(faderId, 'level'), level)
		this.host.setVariable(faderVariableId(faderId, 'level_db'), formatDb(levelDbValue))
	}

	/** Apply a cut state — from the console or an optimistic local write — to cache and UI. */
	private applyFaderCut(faderId: number, isCut: boolean): void {
		const state = this.getOrInitFaderState(faderId)
		const changed = state.isCut !== isCut
		state.isCut = isCut
		this.host.setVariable(faderVariableId(faderId, 'cut'), isCut ? 'On' : 'Off')
		if (changed) this.host.checkFeedbacks('fader_cut_state')
	}

	/** Apply a PFL state — from the console or an optimistic local write — to cache and UI. */
	private applyFaderPfl(faderId: number, isPfl: boolean): void {
		const state = this.getOrInitFaderState(faderId)
		const changed = state.isPfl !== isPfl
		state.isPfl = isPfl
		this.host.setVariable(faderVariableId(faderId, 'pfl'), isPfl ? 'On' : 'Off')
		if (changed) this.host.checkFeedbacks('fader_pfl_state')
	}

	private applyFaderLabel(faderId: number, label: string): void {
		// this.logLiveChange(`Fader ${faderId + 1} label changed to ${JSON.stringify(label)}`)
		this.getOrInitFaderState(faderId).label = label
		this.host.setVariable(faderVariableId(faderId, 'label'), label)
	}

	/** Apply stereo image state — from the console or an optimistic local write — to cache and UI. */
	private applyFaderStereoImage(faderId: number, leftToBoth: boolean, rightToBoth: boolean): void {
		const state = this.getOrInitFaderState(faderId)
		const changed = state.isLeftToBoth !== leftToBoth || state.isRightToBoth !== rightToBoth
		state.isLeftToBoth = leftToBoth
		state.isRightToBoth = rightToBoth
		this.host.setVariable(faderVariableId(faderId, 'left_to_both'), leftToBoth ? 'On' : 'Off')
		this.host.setVariable(faderVariableId(faderId, 'right_to_both'), rightToBoth ? 'On' : 'Off')
		if (changed) this.host.checkFeedbacks('fader_stereo_image')
	}

	private getOrInitFaderState(faderId: number): FaderState {
		let state = this.faderStates.get(faderId)
		if (!state) {
			state = {
				level: MIN_PROTOCOL_LEVEL,
				levelDbValue: CHANNEL_FADER_MIN_DB,
				isCut: false,
				isPfl: null,
				isLeftToBoth: false,
				isRightToBoth: false,
				label: '',
			}
			this.faderStates.set(faderId, state)
		}
		return state
	}
}
