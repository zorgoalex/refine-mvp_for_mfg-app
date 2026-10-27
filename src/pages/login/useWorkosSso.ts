import React from "react";

/** Переход на hosted SSO (WorkOS AuthKit); общий для обоих видов страницы входа. */
export function useWorkosSso() {
  const [redirecting, setRedirecting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const startSso = async () => {
    setRedirecting(true);
    setError(null);
    try {
      const { authApi } = await import("../../api/authApi");
      const url = await authApi.workosAuthorizeUrl();
      window.location.assign(url);
    } catch {
      setError("SSO недоступен, войдите по паролю");
      setRedirecting(false);
    }
  };

  return { redirecting, error, startSso };
}
