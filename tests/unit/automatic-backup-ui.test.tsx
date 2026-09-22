import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AutomaticBackups } from "../../src/ui/components/AutomaticBackups";
import { configureBackups, defaultBackupSettings, readBackupDestination, readBackupSettings, type BackupDirectory } from "../../src/backup/automatic-store";

vi.mock("../../src/backup/automatic-store", async (original) => ({ ...await original<typeof import("../../src/backup/automatic-store")>(), configureBackups: vi.fn(), readBackupSettings: vi.fn(), readBackupDestination: vi.fn() }));
const request = vi.fn(async () => true);
beforeEach(() => {
  vi.mocked(readBackupSettings).mockResolvedValue(defaultBackupSettings());
  vi.mocked(readBackupDestination).mockResolvedValue({ id: "downloads", name: "Downloads/Show Tracker Backups", files: [] });
  request.mockResolvedValue(true);
  vi.stubGlobal("chrome", { permissions: { request }, runtime: { sendMessage: vi.fn(async () => ({ ok: true })) } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("requests Firefox download permission only from the Apply schedule button", async () => {
  vi.stubEnv("FIREFOX", "true");
  render(<AutomaticBackups/>);
  await waitFor(() => expect(screen.getByLabelText("Frequency")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("Frequency"), { target: { value: "weekly" } });
  expect(request).not.toHaveBeenCalled();
  expect(configureBackups).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Apply schedule" }));
  await waitFor(() => expect(configureBackups).toHaveBeenCalledWith("weekly"));
  expect(request).toHaveBeenCalledWith({ permissions: ["downloads"] });
});

it("starts off, offers the three schedules, and disables the test button", async () => {
  render(<AutomaticBackups/>);
  await waitFor(() => expect(screen.getByLabelText("Frequency")).toBeEnabled());
  expect(screen.getByLabelText("Frequency")).toHaveValue("off");
  expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Off", "Daily", "Weekly (recommended)", "Monthly"]);
  expect(screen.getByRole("button", { name: "Back up now" })).toBeDisabled();
});

it("explains an unavailable native picker before the user clicks it", async () => {
  vi.stubGlobal("showDirectoryPicker", undefined);
  render(<AutomaticBackups/>);
  await waitFor(() => expect(screen.getByLabelText("Frequency")).toBeEnabled());
  expect(screen.getByRole("button", { name: "Choose folder…" })).toBeDisabled();
  expect(screen.getByText(/Custom folder selection is disabled or unavailable/)).toHaveTextContent("Downloads backups do not require changing that setting");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("does not enable backups if Downloads permission is declined", async () => {
  request.mockResolvedValue(false);
  render(<AutomaticBackups/>);
  await waitFor(() => expect(screen.getByLabelText("Frequency")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("Frequency"), { target: { value: "weekly" } });
  expect(await screen.findByRole("alert")).toHaveTextContent("not granted");
  expect(configureBackups).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Frequency")).toHaveValue("off");
});

it("enables the selected interval after permission is granted", async () => {
  render(<AutomaticBackups/>);
  await waitFor(() => expect(screen.getByLabelText("Frequency")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("Frequency"), { target: { value: "monthly" } });
  await waitFor(() => expect(configureBackups).toHaveBeenCalledWith("monthly"));
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "AUTO_BACKUP_RUN", force: false });
});

it("a canceled directory picker leaves the current destination unchanged", async () => {
  vi.stubGlobal("showDirectoryPicker", vi.fn(async () => { throw new DOMException("Canceled", "AbortError"); }));
  render(<AutomaticBackups/>);
  const choose = screen.getByRole("button", { name: "Choose folder…" });
  await waitFor(() => expect(choose).toBeEnabled());
  fireEvent.click(choose);
  await waitFor(() => expect(choose).toBeEnabled());
  expect(configureBackups).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("selects a folder with explicit write access without enabling backups automatically", async () => {
  const handle = { name: "Backups", requestPermission: vi.fn(async () => "granted") } as unknown as BackupDirectory;
  vi.stubGlobal("showDirectoryPicker", vi.fn(async () => handle));
  render(<AutomaticBackups/>);
  const choose = screen.getByRole("button", { name: "Choose folder…" });
  await waitFor(() => expect(choose).toBeEnabled());
  fireEvent.click(choose);
  await waitFor(() => expect(configureBackups).toHaveBeenCalledWith("off", handle));
  expect(request).not.toHaveBeenCalled();
});
