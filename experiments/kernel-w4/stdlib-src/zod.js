// stdlib entry: zod -> globalThis.z and globalThis.zod (a small typed validator)
import { z } from "zod";
globalThis.z = z;
globalThis.zod = z;
