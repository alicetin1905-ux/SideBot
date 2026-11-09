// Re-exports used by the unit tests.
import { defaultParams } from './indicators';
import type { StrategyDef } from './strategies';

export { STRATEGIES, customSignals, evalRule } from './strategies';
export const defaultParamsFor = (s: StrategyDef) => defaultParams(s.params);
