import { Toaster as SonnerHost, toast } from "sonner";

/**
 * App-wide toast host. Mount once in __root; fire via notify().
 * Styled through .sw-sonner overrides in components.css (tokens only).
 */
export function ToastHost() {
  return (
    <SonnerHost
      className="sw-sonner"
      position="bottom-right"
      gap={8}
      closeButton
      toastOptions={{ duration: 4000 }}
    />
  );
}

interface NotifyOptions {
  description?: string;
}

/** Fire-and-forget action feedback. Errors stay in page Notices; toasts confirm. */
export const notify = {
  success(message: string, opts?: NotifyOptions) {
    toast.success(message, opts);
  },
  info(message: string, opts?: NotifyOptions) {
    toast(message, opts);
  },
  error(message: string, opts?: NotifyOptions) {
    toast.error(message, opts);
  },
};
