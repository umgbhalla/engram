// stdlib entry: mathjs -> globalThis.math
// V0.7: OPT-IN ONLY. mathjs amplifies ~29x source->heap (746 KB src -> ~20.6 MB heap),
// which trips the OOM cliff. It is NEVER in the default module set and only loads when
// explicitly named in config.modules; even then its source counts against the cap.
import { create, all } from "mathjs";
globalThis.math = create(all);
