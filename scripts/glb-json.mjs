// Reads only the glTF JSON chunk at the start of a remote GLB, with HTTP range requests.

const GLB_MAGIC = 0x46546c67;
const GLB_HEADER_BYTES = 20;

export async function readGlbJson(url) {
  let size = 65536;
  for (;;) {
    const response = await fetch(url, { headers: { Range: `bytes=0-${size - 1}` } });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error(`not a GLB: ${url}`);
    const jsonLength = view.getUint32(12, true);
    if (bytes.length >= GLB_HEADER_BYTES + jsonLength) {
      return JSON.parse(new TextDecoder().decode(bytes.subarray(GLB_HEADER_BYTES, GLB_HEADER_BYTES + jsonLength)));
    }
    size = GLB_HEADER_BYTES + jsonLength;
  }
}
