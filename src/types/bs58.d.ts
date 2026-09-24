/** bs58 ships no type declarations; minimal ambient declaration for the
 * encode/decode surface this project uses. */
declare module "bs58" {
  export function encode(buffer: Uint8Array | ArrayBuffer): string;
  export function decode(input: string): Uint8Array;
  const bs58: {
    encode: typeof encode;
    decode: typeof decode;
  };
  export default bs58;
}
