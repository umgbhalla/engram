// stdlib entry: uuid -> globalThis.uuid {v4, v5, v1, validate, version, ...}
import * as uuid from "uuid";
globalThis.uuid = { ...uuid };
