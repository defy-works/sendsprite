declare module "sns-validator" {
  export default class MessageValidator {
    constructor(hostPattern?: RegExp, encoding?: string);
    validate(
      message: unknown,
      cb: (err: Error | null, message?: unknown) => void,
    ): void;
  }
}
