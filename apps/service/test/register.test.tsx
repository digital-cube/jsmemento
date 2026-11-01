import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, errorField, errorText } from "../src/lib/api.js";
import { validateNewPassword, validateRegister } from "../src/pages/forms.js";
import { RegisterPage } from "../src/pages/Register.js";
import { fail, fakeServer, me, ok, renderAt } from "./fake.js";

afterEach(() => vi.unstubAllGlobals());

function renderRegister(server: ReturnType<typeof fakeServer>) {
  return renderAt(
    <Routes>
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/keys" element={<p data-testid="keys-page">keys</p>} />
      <Route path="/login" element={<p data-testid="login-page">login</p>} />
    </Routes>,
    server,
    "/register",
  );
}

const fill = (email: string, password: string, name: string, terms: boolean) => {
  fireEvent.change(screen.getByTestId("register-email"), { target: { value: email } });
  fireEvent.change(screen.getByTestId("register-password"), { target: { value: password } });
  fireEvent.change(screen.getByTestId("register-name"), { target: { value: name } });
  if (terms) fireEvent.click(screen.getByTestId("register-terms"));
};

const errorOf = (field: string) =>
  screen.getByTestId(`field-${field}`).querySelector(".field__error")?.textContent ?? null;

describe("the register form", () => {
  it("says what is missing under each field and sends nothing", async () => {
    const server = fakeServer();
    renderRegister(server);
    fill("not-an-email", "short", "", false);
    fireEvent.click(screen.getByTestId("register-submit"));
    expect(errorOf("email")).toBe("Not an email address");
    expect(errorOf("password")).toBe("The password needs at least 10 characters");
    expect(errorOf("name")).toBe("Required");
    expect(screen.getByText("Accept the terms to register")).toBeTruthy();
    expect(server.calls.some((c) => c.path === "/auth/register")).toBe(false);
  });

  it("shows and hides the password", () => {
    renderRegister(fakeServer());
    const input = screen.getByTestId("register-password") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.click(screen.getByTestId("register-password-toggle"));
    expect(input.type).toBe("text");
  });

  it("409: the email is taken, with a link to log in", async () => {
    const server = fakeServer({
      routes: { "POST /auth/register": () => fail(409, "conflict", "email already registered") },
    });
    renderRegister(server);
    fill("ana@example.com", "correct horse battery", "Ana", true);
    fireEvent.click(screen.getByTestId("register-submit"));
    const taken = await screen.findByTestId("email-taken");
    expect(taken.textContent).toContain("This email is already registered.");
    expect(taken.querySelector("a")?.getAttribute("href")).toBe("/login?email=ana%40example.com");
  });

  it("puts the server's validation_error under its field", async () => {
    const server = fakeServer({
      routes: {
        "POST /auth/register": () =>
          fail(422, "validation_error", "email: invalid email address", [
            { path: ["email"], message: "invalid email address" },
          ]),
      },
    });
    renderRegister(server);
    fill("ana@example.c", "correct horse battery", "Ana", true);
    fireEvent.click(screen.getByTestId("register-submit"));
    await waitFor(() => expect(errorOf("email")).toBe("invalid email address"));
  });

  it("registers with the header's locale and leads to /keys", async () => {
    let signedIn = false;
    const server = fakeServer({
      routes: {
        "POST /auth/register": () => {
          signedIn = true;
          return ok({ user: me().user, tenant: me().tenant }, 201);
        },
        "GET /auth/me": () => (signedIn ? ok(me({ verified: false })) : undefined),
      },
    });
    renderRegister(server);
    fill("ana@example.com", "correct horse battery", "Ana", true);
    fireEvent.click(screen.getByTestId("register-submit"));
    expect(await screen.findByTestId("keys-page")).toBeTruthy();
    expect(server.calls.find((c) => c.path === "/auth/register")?.body).toEqual({
      email: "ana@example.com",
      password: "correct horse battery",
      name: "Ana",
      locale: "en",
      terms: true,
    });
  });
});

describe("form helpers", () => {
  const t = (_s: string, term: string) => term;
  it("validateRegister accepts a complete form", () => {
    expect(
      validateRegister({ email: "a@b.rs", password: "0123456789", name: "A", terms: true }, t),
    ).toEqual({});
  });
  it("validateNewPassword: length, then equality", () => {
    expect(validateNewPassword("short", "short", t)).toEqual({ password: "SHORT_PASSWORD" });
    expect(validateNewPassword("0123456789", "0123456780", t)).toEqual({ again: "MISMATCH" });
    expect(validateNewPassword("0123456789", "0123456789", t)).toEqual({});
  });
  it("errorField reads the issue path, else the message's prefix", () => {
    expect(errorField(new ApiError(422, "validation_error", "x", [{ path: ["name"] }]))).toBe(
      "name",
    );
    expect(errorField(new ApiError(422, "validation_error", "password: too short"))).toBe(
      "password",
    );
    expect(errorField(new ApiError(422, "validation_error", "nothing"))).toBeNull();
    expect(errorText(new ApiError(422, "validation_error", "password: too short"))).toBe(
      "too short",
    );
  });
});
