/* tslint:disable */
/* eslint-disable */

/**
 * Apply a JSON-encoded patch to a JSON-encoded tree, returning the JSON-encoded result.
 */
export function apply(root: string, patch: string): string;

/**
 * Decode one frame back to a `{"model_type","kind","rev","payload"}` JSON string.
 */
export function decode_frame(frame: Uint8Array): string;

/**
 * Diff two JSON-encoded component trees, returning the JSON-encoded patch.
 *
 * Thin wrapper over the shared core (`spaday::diff_json`); the same code runs in the PyO3 binding.
 */
export function diff(old: string, _new: string): string;

/**
 * Frame a JSON-encoded tree/patch into transports' length-prefixed envelope bytes.
 *
 * `kind` is `"snapshot"` or `"patch"`; `codec` is `"application/json"` or `"application/msgpack"`.
 * `rev` is a `u32` (not `u64`) so JS passes a plain number rather than a BigInt.
 */
export function encode_frame(payload: string, model_type: string, kind: string, rev: number, codec: string): Uint8Array;

/**
 * Interpret a serialized action (the core's DSL wire form) against the DOM primitives in `host`.
 *
 * Behavior is data: the action is parsed + validated by the shared core, then evaluated here with no
 * `eval`. This is the browser-side half of the action DSL — the same model the Python binding authors.
 */
export function interpret(action: string, host: any): void;

/**
 * Parse a `custom-elements.json` manifest into the JSON-encoded list of component schemas.
 */
export function parse_cem(manifest: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly apply: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly decode_frame: (a: number, b: number) => [number, number, number, number];
    readonly diff: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly encode_frame: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number, number];
    readonly interpret: (a: number, b: number, c: any) => [number, number];
    readonly parse_cem: (a: number, b: number) => [number, number, number, number];
    readonly wasm_bindgen_1019a2f937c7d9b2___convert__closures_____invoke___wasm_bindgen_1019a2f937c7d9b2___JsValue__core_ed718c3d60ebd546___result__Result_____wasm_bindgen_1019a2f937c7d9b2___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
