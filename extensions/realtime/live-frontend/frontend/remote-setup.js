/**
 * Remote access auto-configuration.
 *
 * When the page is opened via a Cloudflare/ngrok tunnel, the URL query params
 * ?proxy=wss://...&openclaw=wss://... are read and injected into the
 * corresponding input fields so the user doesn't have to type anything.
 *
 * This file is optional — removing the <script> tag has zero effect on local usage.
 */
(function remoteSetup() {
  const params = new URLSearchParams(window.location.search);
  const proxyUrl = params.get("proxy");
  const openclawUrl = params.get("openclaw");

  if (proxyUrl) {
    const el = document.getElementById("proxyUrl");
    if (el) el.value = proxyUrl;
  }
  if (openclawUrl) {
    const el = document.getElementById("openclawUrl");
    if (el) el.value = openclawUrl;
  }
})();
