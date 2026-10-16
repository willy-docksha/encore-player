// where the ai models are downloaded from (see README "Model AI").
// the models (~240 mb) are too big for vercel's free plan, so the public site loads them from a
// separate host such as a hugging face repo: "https://huggingface.co/<user>/<repo>/resolve/main/".
// empty = the models/ folder next to the app (local dev, or a host that allows big files).
export const MODEL_URL = "";
