export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code = "bad_request",
  ) {
    super(message);
    this.name = "AppError";
  }
}
