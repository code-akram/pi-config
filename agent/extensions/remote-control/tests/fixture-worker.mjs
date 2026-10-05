// Test-only control endpoint on the internal DO stub, never bundled/deployed.
import worker, { RcRelay } from "../.build/index.js";
export default worker;
export class TestRelay extends RcRelay {
  async fetch(request) {
    if (new URL(request.url).pathname === "/__test/alarm") {
      await this.alarm();
      return new Response("ok");
    }
    return super.fetch(request);
  }
}
