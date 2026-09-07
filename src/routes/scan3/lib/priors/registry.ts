/**
 * Every available `PriorSource`, literature and subject alike, as equal entries in one list -- this is
 * the "M available" `fuseSources.ts`/`priorSource.ts` are designed around. Adding a new InterHand2.6M
 * subject (run `generateFittedSubject.ts`) or, eventually, a real `/scan3` capture's own posterior is
 * just one more import and one more array entry here; nothing else needs to change.
 */

import { INTERHAND_0_SOURCE } from './fitted/interhand-0'
import { LITERATURE_SOURCE, type PriorSource } from './priorSource'

export const ALL_PRIOR_SOURCES: PriorSource[] = [LITERATURE_SOURCE, INTERHAND_0_SOURCE]
