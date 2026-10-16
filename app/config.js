// where the ai models are downloaded from (see README "Model AI").
// the models (~240 mb) are too big for vercel's free plan, so the public site loads them from a
// separate host such as a hugging face repo: "https://huggingface.co/<user>/<repo>/resolve/main/".
// empty = the models/ folder next to the app (local dev, or a host that allows big files).
// false = new breakdown songs wait in the queue until "Mulai" is pressed.
// set to true once analysis runs on a fast server and can start right away.
export const AUTO_START = false;

export const MODEL_URL = "https://huggingface.co/willydocksha/encore-models/resolve/main/";
