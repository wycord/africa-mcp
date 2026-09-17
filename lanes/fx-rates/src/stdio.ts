#!/usr/bin/env node
/**
 * FX & Parallel Rates lane stdio entrypoint — run this to add the 7 FX tools to
 * Claude Code / Desktop. Provider is chosen by FX_PROVIDER (default "mock"; set
 * "live" for central-bank sources + Quidax parallel, no key).
 */
import { startStdio } from "@braynexservices/africa-mcp-core";
import { fxTools } from "./tools.js";
import { getFxProvider } from "./provider.js";

await startStdio(fxTools(getFxProvider()), { name: "africa-fx-rates" });