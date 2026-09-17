/**
 * Selects the active FX provider from env (FX_PROVIDER, default "mock") via the core
 * registry. Adding a validated source family = one import + one registry entry.
 */
import { loadConfig, selectProvider, type FxProvider } from "@braynexservices/africa-mcp-core";
import { MockFxProvider } from "./providers/mock.js";
import { LiveFxProvider } from "./providers/live.js";

export function getFxProvider(key?: string): FxProvider {
  const provider = key ?? loadConfig().fxProvider;
  return selectProvider<FxProvider>("FX", provider, {
    mock: () => new MockFxProvider(),
    live: () => new LiveFxProvider(),
  });
}