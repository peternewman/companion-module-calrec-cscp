import type { CompanionVariableDefinition, CompanionVariableValues } from '@companion-module/base'

export type VariableValue = string | number


export const FADER_VARIABLE_SUFFIXES = [
	'label',
	'level',
	'level_db',
	'pfl',
	'cut',
	'left_to_both',
	'right_to_both',
] as const

export type FaderVariableSuffix = (typeof FADER_VARIABLE_SUFFIXES)[number]

/** Companion exposes faders 1-based; the protocol and library are 0-based. */
export function faderVariableId(faderId: number, suffix: FaderVariableSuffix): string {
	return `fader_${faderId + 1}_${suffix}`
}

/** The slice of `InstanceBase` needed here, so it can be exercised without Companion. */
export interface VariableHost {
	setVariableDefinitions(definitions: CompanionVariableDefinition[]): void
	setVariableValues(values: CompanionVariableValues): void
}

/**
 * Publishes Companion variables, skipping writes whose value has not actually changed.
 */
export class VariableStore {
	/** Last value sent per variable. */
	private readonly cache = new Map<string, VariableValue>()
	/** Fader count last declared to Companion. */
	private declaredFaderCount = 0

	constructor(private readonly host: VariableHost) {}

	/**
	 * Declare the full fader variable set for `maxFaderCount`.
	 * Safe to call repeatedly; only rebuilds definitions when the count changes.
	 */
	declareFaderVariables(maxFaderCount: number): void {
		if (this.declaredFaderCount === maxFaderCount) return

		const definitions: CompanionVariableDefinition[] = []
		for (let faderId = 0; faderId < maxFaderCount; faderId++) {
			for (const suffix of FADER_VARIABLE_SUFFIXES) {
				const variableId = faderVariableId(faderId, suffix)
				definitions.push({ variableId, name: variableId.replace(/_/g, ' ') })
			}
		}

		this.cache.clear()
		this.declaredFaderCount = maxFaderCount
		this.host.setVariableDefinitions(definitions)
	}

	/** Publish a value if it differs from what Companion already has. */
	set(variableId: string, value: VariableValue): void {
		if (this.cache.get(variableId) === value) return
		this.cache.set(variableId, value)
		this.host.setVariableValues({ [variableId]: value })
	}

	/** Drop all bookkeeping so the next declaration starts clean. */
	reset(): void {
		this.cache.clear()
		this.declaredFaderCount = 0
	}
}
