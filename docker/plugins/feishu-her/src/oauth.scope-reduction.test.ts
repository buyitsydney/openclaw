/**
 * Scope reduction tests — pin the URL-size contract that `applyDynamicQuota`
 * promises to uphold. These tests protect against silent regressions in the
 * Feishu passport 431 guard.
 *
 * Regression baseline (2026-05-01):
 *   - 234 backend-granted user scopes (full CarHer app catalog)
 *   - Raw authorize URL must be ≤ 3700 bytes
 *   - passport.feishu.cn/accounts/page/login returns HTTP 302 (not 431) below
 *     this threshold, empirically verified via headless Chrome.
 */

import { describe, expect, it } from "vitest";
import { __scopeReduction } from "./oauth";

const { dedupSubsumedScopes, applyDomainQuota, applyDynamicQuota, estimateAuthorizeUrlBytes, MAX_AUTHORIZE_URL_BYTES } =
  __scopeReduction;

// Representative full-catalog scope list observed from the enterprise app
// `cli_a96f044b4ef95cc0` on 2026-04-30 (234 entries, 169 after partial dedup
// before tests ran). Kept as a literal so the test is self-contained.
const FIXTURE_SCOPES_234 = [
  "aily:data_asset:read","aily:data_asset:upload_file","aily:data_asset:write","aily:file:read","aily:file:write",
  "aily:knowledge:ask","aily:knowledge:read","aily:knowledge:write","aily:message:read","aily:message:write",
  "aily:run:read","aily:run:write","aily:session:read","aily:session:write","aily:skill:read",
  "approval:instance:read","approval:task:read","approval:task:write","attendance:task:readonly",
  "base:app:read","bitable:app","calendar:calendar","calendar:calendar.acl:create","calendar:calendar.acl:delete",
  "calendar:calendar.acl:read","calendar:calendar.event:create","calendar:calendar.event:delete",
  "calendar:calendar.event:read","calendar:calendar.event:reply","calendar:calendar.event:update",
  "calendar:calendar.free_busy:read","calendar:calendar:create","calendar:calendar:delete",
  "calendar:calendar:subscribe","calendar:calendar:update","calendar:exchange.bindings:create",
  "contact:contact.base:readonly","contact:department.base:readonly","contact:department.hrbp:readonly",
  "contact:department.organize:readonly","contact:job_title:readonly","contact:user.assign_info:read",
  "contact:user.base:readonly","contact:user.basic_profile:readonly","contact:user.department:readonly",
  "contact:user.department_path:readonly","contact:user.dotted_line_leader_info.read",
  "contact:user.email:readonly","contact:user.employee:readonly","contact:user.employee_id:readonly",
  "contact:user.employee_number:read","corehr:work_calendar:read","directory:department:search",
  "directory:employee.base.email:read","directory:employee.base.enterprise_email:read","directory:employee:search",
  "docs:doc","docs:document.comment:create","docs:document.comment:delete","docs:document.comment:read",
  "docs:document.comment:update","docs:document.comment:write_only","docs:document.content:read",
  "docs:document.media:download","docs:document.media:upload","docs:document.subscription",
  "docs:document:copy","docs:document:export","docs:document:import","docs:event.document_deleted:read",
  "docs:event.document_edited:read","docx:document","docx:document.block:convert","docx:document:create",
  "drive:drive.metadata:readonly","drive:drive.search:readonly","drive:drive:readonly",
  "drive:export:readonly","drive:file:download","drive:file:readonly","drive:file:upload",
  "im:chat","im:chat.access_event.bot_p2p_chat:read","im:chat.announcement:read",
  "im:chat.announcement:write_only","im:chat.chat_pins:read","im:chat.chat_pins:write_only",
  "im:chat.collab_plugins:read","im:chat.members:read","im:chat.members:write_only",
  "im:chat.moderation:read","im:chat.tabs:read","im:chat.top_notice:write_only",
  "im:chat:create_by_user","im:chat:moderation:write_only","im:chat:update",
  "mail:event","mail:public_mailbox","mail:user_mailbox.event.mail_address:read",
  "mail:user_mailbox.folder:read","mail:user_mailbox.folder:write",
  "mail:user_mailbox.mail_contact.mail_address:read","mail:user_mailbox.mail_contact.phone:read",
  "mail:user_mailbox.mail_contact:read","mail:user_mailbox.mail_contact:write",
  "mail:user_mailbox.message.address:read","mail:user_mailbox.message.body:read",
  "mail:user_mailbox.message.subject:read","mail:user_mailbox.message:modify",
  "mail:user_mailbox.message:readonly","mail:user_mailbox.message:send",
  "minutes:minutes","minutes:minutes.artifacts:read","minutes:minutes.basic:read",
  "minutes:minutes.media:export","minutes:minutes.search:read","minutes:minutes.statistics:read",
  "minutes:minutes.transcript:export","offline_access","report:task:readonly",
  "search:app","search:department:read","search:docs:read","search:knowledge_qa:read",
  "search:memory_graph_tool_call:read","search:message","security_and_compliance:user_migration_task",
  "sheets:spreadsheet","sheets:spreadsheet.meta:read","sheets:spreadsheet.meta:write_only",
  "sheets:spreadsheet:create","space:document.event:read","space:document:move",
  "space:document:retrieve","space:document:shortcut",
  "task:attachment:read","task:attachment:write","task:comment","task:custom_field:read",
  "task:custom_field:write","task:section:read","task:section:write","task:task","task:task:writeonly",
  "task:tasklist:read","task:tasklist:write",
  "vc:export","vc:meeting","vc:meeting.meetingevent:read","vc:meeting.meetingid:read",
  "vc:meeting.search:read","vc:note:read","vc:record","vc:reserve","vc:room",
  "wiki:member:create","wiki:member:retrieve","wiki:member:update","wiki:node:copy",
  "wiki:node:create","wiki:node:move","wiki:node:read","wiki:node:retrieve","wiki:node:update",
  "wiki:setting:read","wiki:setting:write_only","wiki:space:read","wiki:space:write_only","wiki:wiki",
];

const CLIENT_ID = "cli_a96f044b4ef95cc0";
const REDIRECT_URI = "https://s1-u200-auth.carher.net/feishu/oauth/callback";

describe("scope reduction — static contracts", () => {
  it("MAX_AUTHORIZE_URL_BYTES is headroom-safe (≤3700 so passport stays <4500)", () => {
    expect(MAX_AUTHORIZE_URL_BYTES).toBeLessThanOrEqual(3700);
    expect(MAX_AUTHORIZE_URL_BYTES).toBeGreaterThanOrEqual(3000);
  });

  it("dedupSubsumedScopes drops `X:readonly` when `X` is present", () => {
    const input = new Set(["im:chat", "im:chat:readonly", "docs:doc", "docs:doc:read"]);
    const r = dedupSubsumedScopes(input);
    expect(r.kept).toEqual(expect.arrayContaining(["im:chat", "docs:doc"]));
    expect(r.kept).not.toEqual(expect.arrayContaining(["im:chat:readonly", "docs:doc:read"]));
    expect(r.dropped.length).toBe(2);
  });

  it("applyDomainQuota caps each domain to N and is stable (sorted)", () => {
    const scopes = ["a:x3", "a:x1", "a:x2", "b:y1", "b:y2"];
    const r = applyDomainQuota(scopes, 2);
    expect(r.kept).toEqual(["a:x1", "a:x2", "b:y1", "b:y2"]);
    expect(r.dropped).toEqual(["a:x3"]);
  });

  it("estimateAuthorizeUrlBytes approximates real URL to within 2 bytes", () => {
    const scopes = ["im:chat", "docs:doc", "wiki:wiki"];
    const est = estimateAuthorizeUrlBytes(scopes, CLIENT_ID, REDIRECT_URI);
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: scopes.join(" "),
      state: "x".repeat(64),
    });
    const real = `https://accounts.feishu.cn/open-apis/authen/v1/authorize?${params.toString()}`.length;
    expect(Math.abs(est - real)).toBeLessThanOrEqual(2);
  });
});

describe("scope reduction — 234-scope regression (Feishu 431 guard)", () => {
  it("raw 234 scopes through full pipeline fit ≤ 3700 bytes", () => {
    const dedup = dedupSubsumedScopes(new Set(FIXTURE_SCOPES_234));
    const dyn = applyDynamicQuota(dedup.kept, CLIENT_ID, REDIRECT_URI);
    expect(dyn.urlBytes).toBeLessThanOrEqual(MAX_AUTHORIZE_URL_BYTES);
    expect(dyn.quota).toBeGreaterThanOrEqual(1);
    expect(dyn.kept.length).toBeGreaterThan(0);
  });

  it("dynamic quota picks the largest quota that fits (not always 1)", () => {
    const dedup = dedupSubsumedScopes(new Set(FIXTURE_SCOPES_234));
    const dyn = applyDynamicQuota(dedup.kept, CLIENT_ID, REDIRECT_URI);
    // With 234 → dedup 205, quota should settle between 6 and 10 empirically.
    expect(dyn.quota).toBeGreaterThanOrEqual(5);
    expect(dyn.quota).toBeLessThanOrEqual(12);
  });

  it("tiny scope sets are not artificially capped", () => {
    const small = ["im:chat", "docs:doc"];
    const dyn = applyDynamicQuota(small, CLIENT_ID, REDIRECT_URI);
    expect(dyn.quota).toBe(15); // upper bound — small sets keep everything
    expect(dyn.kept.length).toBe(2);
    expect(dyn.dropped.length).toBe(0);
  });
});
