// Measures the world-space bounding box of every model in a pack whose metadata has no size, from the GLB's JSON
// alone: each mesh's POSITION min/max corners go through its node's world matrix. Only packs whose files are in
// metres belong here.
//   node scripts/measure-bounds.mjs menagerie-glb   → cache/bounds/menagerie-glb.json  { id: [x, y, z] }
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readGlbJson } from "./glb-json.mjs";

const projectFolder = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACK_BASE = "https://huggingface.co/datasets/codepawl";
const PARALLEL_REQUESTS = 8;

function identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

// Column-major 4x4 multiply, as glTF stores matrices.
function multiply(left, right) {
  const result = new Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += left[k * 4 + row] * right[column * 4 + k];
      result[column * 4 + row] = sum;
    }
  }
  return result;
}

function localMatrix(node) {
  if (node.matrix) return node.matrix;
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [scaleX, scaleY, scaleZ] = node.scale ?? [1, 1, 1];
  const [moveX, moveY, moveZ] = node.translation ?? [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * scaleX, 2 * (x * y + z * w) * scaleX, 2 * (x * z - y * w) * scaleX, 0,
    2 * (x * y - z * w) * scaleY, (1 - 2 * (x * x + z * z)) * scaleY, 2 * (y * z + x * w) * scaleY, 0,
    2 * (x * z + y * w) * scaleZ, 2 * (y * z - x * w) * scaleZ, (1 - 2 * (x * x + y * y)) * scaleZ, 0,
    moveX, moveY, moveZ, 1,
  ];
}

function transformPoint(matrix, [x, y, z]) {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

export function worldBounds(gltf) {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  const sceneIndex = gltf.scene ?? 0;
  const roots = gltf.scenes?.[sceneIndex]?.nodes ?? [];
  const visit = (nodeIndex, parentMatrix) => {
    const node = gltf.nodes[nodeIndex];
    const world = multiply(parentMatrix, localMatrix(node));
    if (node.mesh !== undefined) {
      for (const primitive of gltf.meshes[node.mesh].primitives) {
        const accessor = gltf.accessors[primitive.attributes.POSITION];
        if (!accessor?.min || !accessor?.max) continue;
        for (let corner = 0; corner < 8; corner += 1) {
          const point = [0, 1, 2].map((axis) => ((corner >> axis) & 1 ? accessor.max[axis] : accessor.min[axis]));
          const moved = transformPoint(world, point);
          for (let axis = 0; axis < 3; axis += 1) {
            low[axis] = Math.min(low[axis], moved[axis]);
            high[axis] = Math.max(high[axis], moved[axis]);
          }
        }
      }
    }
    for (const child of node.children ?? []) visit(child, world);
  };
  for (const root of roots) visit(root, identity());
  if (!Number.isFinite(low[0])) return null;
  return high.map((value, axis) => Number((value - low[axis]).toFixed(4)));
}

async function measurePack(pack) {
  const rows = readFileSync(join(projectFolder, "cache", "packs", pack, "metadata.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const sizes = {};
  let next = 0;
  async function worker() {
    while (next < rows.length) {
      const row = rows[next++];
      const id = row.id ?? row.name;
      const path = row.file_name ?? row.file;
      try {
        const gltf = await readGlbJson(`${PACK_BASE}/${pack}/resolve/main/${path.split("/").map(encodeURIComponent).join("/")}`);
        sizes[id] = worldBounds(gltf);
      } catch (error) {
        console.error(`${pack} ${id}: ${error.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: PARALLEL_REQUESTS }, worker));
  mkdirSync(join(projectFolder, "cache", "bounds"), { recursive: true });
  writeFileSync(join(projectFolder, "cache", "bounds", `${pack}.json`), JSON.stringify(sizes, null, 1));
  console.log(`${pack}: ${Object.values(sizes).filter(Boolean).length} of ${rows.length} measured`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const pack of process.argv.slice(2)) await measurePack(pack);
}
