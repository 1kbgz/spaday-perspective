declare module "*.css" {
  const content: string;
  export default content;
}

declare module "*.wasm" {
  const content: Uint8Array;
  export default content;
}
