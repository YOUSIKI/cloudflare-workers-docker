import { Hono, Context } from "hono";

const app = new Hono();

// Mapping for upstream registry hosts.
const ROUTES: Record<string, string> = {
  docker: "registry-1.docker.io",
  gcr: "gcr.io",
  ghcr: "ghcr.io",
  k8s: "registry.k8s.io",
  lscr: "lscr.io",
  nvcr: "nvcr.io",
  quay: "quay.io",
};

// Proxy token requests to Docker auth server.
app.all("/token", async (c: Context) => {
  const targetHost = getTargetHost(c);
  if (targetHost !== ROUTES["docker"]) {
    return c.text("Invalid request", { status: 400 });
  }
  const params = {
    headers: {
      Host: "auth.docker.io",
      "User-Agent": c.req.header("User-Agent") ?? "",
      Accept: c.req.header("Accept") ?? "",
      "Accept-Language": c.req.header("Accept-Language") ?? "",
      "Accept-Encoding": c.req.header("Accept-Encoding") ?? "",
      Connection: "keep-alive",
      "Cache-Control": "max-age=0",
    },
  };
  const url = new URL(c.req.url);
  const response = await fetch(
    new Request("https://auth.docker.io" + url.pathname + url.search, params)
  );
  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
});

app.all("/*", async (c: Context) => {
  // Parse the incoming URL
  let url = new URL(c.req.url);

  // Determine target host via query params and mapping.
  let targetHost = getTargetHost(c);

  // Override the target host for Docker requests.
  url.hostname = targetHost;

  // Handle encoded %2F and %3A: if no %2F is in the query but %3A exists, rewrite it.
  if (!/%2F/.test(url.search) && /%3A/.test(url.toString())) {
    // Adjust %3A to include 'library%2F'
    const modifiedUrlStr = url
      .toString()
      .replace(/%3A(?=.*?&)/, "%3Alibrary%2F");
    url = new URL(modifiedUrlStr);
  }

  // Handle /v2/ requests
  if (
    targetHost === ROUTES["docker"] &&
    /^\/v2\/[^/]+\/[^/]+\/[^/]+$/.test(url.pathname) &&
    !/^\/v2\/library/.test(url.pathname)
  ) {
    url.pathname = "/v2/library/" + url.pathname.split("/v2/")[1];
  }

  const params = {
    headers: {
      Host: targetHost,
      "User-Agent": c.req.header("User-Agent") ?? "",
      Accept: c.req.header("Accept") ?? "",
      "Accept-Language": c.req.header("Accept-Language") ?? "",
      "Accept-Encoding": c.req.header("Accept-Encoding") ?? "",
      Connection: "keep-alive",
      "Cache-Control": "max-age=0",
      Authorization: c.req.header("Authorization") ?? "",
      "X-Amz-Content-Sha256": c.req.header("X-Amz-Content-Sha256") ?? "",
      "x-amz-date": c.req.header("x-amz-date") ?? "",
    },
    cacheTtl: 3600,
  };

  console.log("params", params);

  // Forward the request to the target host.
  const response = await fetch(new Request(url.toString(), params));

  let responseHeader = new Headers(response.headers);

  // Handle Www-Authenticate header.
  if (responseHeader.has("Www-Authenticate")) {
    responseHeader.set(
      "Www-Authenticate",
      (responseHeader.get("Www-Authenticate")?.toString() ?? "").replace(
        /https:\/\/auth.docker.io/g,
        "https://" + c.req.header("host")
      )
    );
  }

  return new Response(response.body, {
    status: response.status,
    headers: responseHeader,
  });
});

// Determine target host based on query params.
function getTargetHost(c: Context): string {
  const url = new URL(c.req.url);
  const ns = url.searchParams.get("ns");
  const hubhost = url.searchParams.get("hubhost") || url.hostname;
  const hubhostTop = hubhost.split(".")[0];
  const targetHost = ns
    ? ns === "docker.io"
      ? ROUTES["docker"]
      : ns
    : ROUTES[hubhostTop] || ROUTES["docker"];
  return targetHost;
}

export default app;
