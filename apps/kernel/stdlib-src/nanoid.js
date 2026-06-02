// stdlib entry: nanoid -> globalThis.nanoid (+ customAlphabet)
import { nanoid, customAlphabet } from "nanoid";
globalThis.nanoid = nanoid;
globalThis.nanoid.customAlphabet = customAlphabet;
