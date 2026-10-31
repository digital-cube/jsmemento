export { describeDatabaseUrl, type FriendlyError, friendlyError } from "./errors.js";
export { buildProgram, type CliIO, type CliOptions, runCli } from "./program.js";
export {
  clock,
  DEFAULT_SERVER_URL,
  runTail,
  TailError,
  type TailOptions,
  tailLine,
  tailQuery,
} from "./tail.js";
export {
  inquirerPrompter,
  makeUi,
  oraSpinner,
  type Prompter,
  type Spinner,
  type SpinnerFactory,
} from "./ui.js";
