import { Chalk, type ChalkInstance } from "chalk";
import ora from "ora";

/** The questions the CLI asks in a terminal. `@inquirer/prompts` by default; tests pass a script. */
export interface Prompter {
  input(options: {
    message: string;
    default?: string;
    validate?: (value: string) => true | string;
  }): Promise<string>;
  select<T>(options: { message: string; choices: { name: string; value: T }[] }): Promise<T>;
  checkbox<T>(options: {
    message: string;
    choices: { name: string; value: T; checked?: boolean }[];
    required?: boolean;
  }): Promise<T[]>;
  confirm(options: { message: string; default?: boolean }): Promise<boolean>;
}

/** Loads `@inquirer/prompts` only when a question is actually asked. */
export const inquirerPrompter: Prompter = {
  input: async (options) => (await import("@inquirer/prompts")).input(options),
  select: async (options) => (await import("@inquirer/prompts")).select(options),
  checkbox: async (options) => (await import("@inquirer/prompts")).checkbox(options),
  confirm: async (options) => (await import("@inquirer/prompts")).confirm(options),
};

export interface Spinner {
  stop(): void;
}

export type SpinnerFactory = (text: string) => Spinner;

const silentSpinner: Spinner = { stop() {} };

/** An `ora` spinner on stderr, so stdout stays clean for pipes and `--json`. */
export const oraSpinner: SpinnerFactory = (text) => {
  const spinner = ora({ text, stream: process.stderr }).start();
  return { stop: () => void spinner.stop() };
};

export interface Ui {
  c: ChalkInstance;
  /** Runs `fn` behind a spinner (when spinners are on). */
  step<T>(text: string, fn: () => Promise<T>): Promise<T>;
}

export function makeUi(color: boolean, spinner: SpinnerFactory | null): Ui {
  const c = new Chalk({ level: color ? 1 : 0 });
  return {
    c,
    async step(text, fn) {
      const s = spinner ? spinner(text) : silentSpinner;
      try {
        return await fn();
      } finally {
        s.stop();
      }
    },
  };
}
