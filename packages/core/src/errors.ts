/** Thrown when an input file is missing, unreadable, or not in the expected shape. CLI exit code 2. */
export class InputError extends Error {
  constructor(
    message: string,
    readonly file?: string,
  ) {
    super(file ? `${file}: ${message}` : message);
    this.name = "InputError";
  }
}
