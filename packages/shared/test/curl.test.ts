import { describe, expect, it } from "vitest";
import {
  CurlCommandError,
  parseCurlCommand,
  serializeCurlRequest,
} from "../src/curl.js";

describe("cURL import and export", () => {
  it("imports a multiline chat request and round-trips literal JSON and credentials", () => {
    const command = `curl --noproxy 'api.example.test' \\
      'https://api.example.test/v1/chat/completions' \\
      -H "Authorization: Bearer test-key" \\
      -H 'Content-Type: application/json' \\
      -H 'bedrock_lane: traffic-tag' \\
      -d '{
        "model": "example",
        "messages": [{"role":"user","content":"你好，path \\\\n $literal \`literal\`"}],
        "stream":false
      }'`;
    const request = parseCurlCommand(command);
    expect(request).toMatchObject({
      method: "POST",
      noProxy: "api.example.test",
      url: "https://api.example.test/v1/chat/completions",
      headers: [
        "Authorization: Bearer test-key",
        "Content-Type: application/json",
        "bedrock_lane: traffic-tag",
      ],
    });
    expect(JSON.parse(request.body ?? "").messages[0].content).toContain(
      "$literal",
    );
    expect(parseCurlCommand(serializeCurlRequest(request))).toEqual(request);
  });

  it("handles quotes, empty arguments, attached values and common flags", () => {
    const request = parseCurlCommand(
      `curl -sSL 'https://example.test?q=1&b=2' -XPOST -H'X-Test: a' --data-raw='' --noproxy='' --max-time=30 --compressed`,
    );
    expect(request).toMatchObject({
      method: "POST",
      body: "",
      noProxy: "",
      followRedirects: true,
      compressed: true,
      timeoutSeconds: 30,
    });
    request.body = `it's a "quote"\nwith \\ backslashes and $(literal)`;
    expect(parseCurlCommand(serializeCurlRequest(request))).toEqual(request);
  });

  it("accepts a custom timeout and treats 0 as no limit", () => {
    const custom = parseCurlCommand(
      "curl https://example.test --max-time 3600",
    );
    expect(custom.timeoutSeconds).toBe(3600);
    expect(serializeCurlRequest(custom)).toContain("--max-time 3600");
    expect(parseCurlCommand(serializeCurlRequest(custom))).toEqual(custom);

    const unlimited = parseCurlCommand("curl https://example.test -m 0");
    expect(unlimited.timeoutSeconds).toBeNull();
    expect(serializeCurlRequest(unlimited)).toContain("--max-time 0");
    expect(parseCurlCommand(serializeCurlRequest(unlimited))).toEqual(
      unlimited,
    );

    const omitted = parseCurlCommand("curl https://example.test");
    expect(omitted.timeoutSeconds).toBe(120);
    expect(serializeCurlRequest(omitted)).toContain("--max-time 120");
  });

  it("matches JSON defaults, repeated data and query semantics", () => {
    const json = parseCurlCommand(`curl https://example.test --json '{"a":1}'`);
    expect(json.headers).toEqual([
      "Content-Type: application/json",
      "Accept: application/json",
    ]);
    expect(
      parseCurlCommand("curl https://example.test -d a=1 -d b=2").body,
    ).toBe("a=1&b=2");
    expect(
      parseCurlCommand("curl 'https://example.test/path?x=1#part' -G -d a=2"),
    ).toMatchObject({
      method: "GET",
      body: null,
      url: "https://example.test/path?x=1&a=2#part",
    });
  });

  it("exports every request option with literal shell quoting", () => {
    const request = {
      ...parseCurlCommand("curl https://example.test"),
      url: "https://example.test/v1?q[]=one&name=O'Reilly",
      method: "PATCH",
      headers: ["Authorization: Bearer full-test-key", "X-Note: it's literal"],
      body: `{"content":"it's $literal \`literal\` \\\\ 你好"}\n`,
      noProxy: "",
      proxy: "http://localhost:7890",
      basicAuth: "test:secret'password",
      followRedirects: true,
      insecure: true,
      compressed: true,
      timeoutSeconds: 600,
    };
    const exported = serializeCurlRequest(request);
    expect(exported).toContain("curl --globoff --no-buffer");
    expect(exported).toContain("-X PATCH");
    expect(exported).toContain("-H 'Authorization: Bearer full-test-key'");
    expect(exported).toContain("O'\\''Reilly");
    expect(exported).toContain("--noproxy ''");
    expect(exported).toContain("--proxy 'http://localhost:7890'");
    expect(exported).toContain("--user 'test:secret'\\''password'");
    expect(exported).toContain("--location");
    expect(exported).toContain("--insecure");
    expect(exported).toContain("--compressed");
    expect(exported).toContain("--max-time 600");
    expect(parseCurlCommand(exported)).toEqual(request);
  });

  it.each([
    ["curl https://example.test -K /tmp/config", "option"],
    ["curl https://example.test --output /tmp/target", "option"],
    ["curl https://example.test -d @/etc/passwd", "file"],
    ["curl https://example.test -H @headers", "file"],
    ["curl file:///etc/passwd", "url"],
    ["curl https://user:password@example.test", "url"],
    ["curl https://example.test https://other.test", "multipleUrls"],
    ["curl https://example.test; touch /tmp/x", "shell"],
    ['curl https://example.test -H "Authorization: $KEY"', "shell"],
    ['curl https://example.test -d "$(cat /etc/passwd)"', "shell"],
    ["curl https://example.test | cat", "shell"],
    ["curl 'https://example.test", "quotes"],
    ["curl https://example.test --max-time 3601", "limit"],
    ["curl https://example.test -H 'Bad\nHeader: value'", "header"],
    ["curl https://example.test -I -d body", "method"],
    ["curl https://example.test --location=false", "value"],
  ])("rejects unsupported semantics: %s", (command, code) => {
    try {
      parseCurlCommand(command);
      expect.fail("must reject");
    } catch (error) {
      expect(error).toBeInstanceOf(CurlCommandError);
      expect((error as CurlCommandError).code).toBe(code);
    }
  });
});
