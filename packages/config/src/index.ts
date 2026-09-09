export { LOG_LEVELS, LLM_PROVIDERS, HINTS, requiredKeysFor } from "./schema.ts";
export type { PlumblineConfig, ConfigValue, ConfigValueMap, LogLevel, LlmProvider } from "./schema.ts";

export { loadConfig, getConfigValue, isConfigComplete, seedConfig, __isSeeded, __resetSeedForTests } from "./loader.ts";
export type { ConfigCompletenessResult } from "./loader.ts";

export { setConfigValue, ensurePlumblineHome, ConfigSeededError } from "./writer.ts";

export {
  getPlumblineHome,
  getConfigPath,
  isDevMode,
  isForceHaltOnceEnabled,
  setPlumblineHomeResolver,
  __setPlumblineHomeForTests,
} from "./paths.ts";
