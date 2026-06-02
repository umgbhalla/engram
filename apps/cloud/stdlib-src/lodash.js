// stdlib entry: lodash-es -> globalThis._ and globalThis.lodash
import * as lodash from "lodash-es";
const _ = { ...lodash };
globalThis._ = _;
globalThis.lodash = _;
