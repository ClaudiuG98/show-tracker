import { useState } from "react";

type AsyncButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & {
  onAction: (event: React.MouseEvent<HTMLButtonElement>) => Promise<unknown>;
  busyLabel?: string;
  successLabel?: string;
  busy?: boolean;
};

export function AsyncButton({ onAction, busyLabel = "Working…", successLabel, busy = false, children, disabled, className = "", ...props }: AsyncButtonProps) {
  const [state, setState] = useState<"idle" | "busy" | "success" | "error">("idle"), [error, setError] = useState("");
  const run = async (event: React.MouseEvent<HTMLButtonElement>) => {
    if (state === "busy") return;
    setState("busy"); setError("");
    try {
      await onAction(event);
      if (successLabel) { setState("success"); window.setTimeout(() => setState("idle"), 1_600); }
      else setState("idle");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The action could not be completed."); setState("error");
    }
  };
  const isBusy = busy || state === "busy";
  return <span className={`async-control ${isBusy ? "busy" : state}`}><button {...props} className={`${className} async-button`.trim()} disabled={disabled || isBusy} aria-busy={isBusy} onClick={(event) => void run(event)}>{isBusy ? <><span className="button-spinner" aria-hidden="true"/>{busyLabel && <span>{busyLabel}</span>}</> : <span>{state === "success" && successLabel ? successLabel : children}</span>}</button>{state === "error" && <span className="button-feedback" role="alert">{error} Try again.</span>}</span>;
}
