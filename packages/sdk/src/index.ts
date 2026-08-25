export { SendspriteError, type SendspriteErrorCode } from "./errors";
export {
  type SendspriteOptions,
  type RequestOptions,
  SDK_VERSION,
} from "./client";

import { HttpClient, type SendspriteOptions } from "./client";

/** Sendsprite API client. Resource helpers are attached in later tasks. */
export class Sendsprite extends HttpClient {
  constructor(options?: SendspriteOptions) {
    super(options);
  }
}
