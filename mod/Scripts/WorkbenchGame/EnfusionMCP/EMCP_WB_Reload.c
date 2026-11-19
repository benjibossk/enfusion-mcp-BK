/**
 * EMCP_WB_Reload.c - Script reload handler
 *
 * Triggers the Script Editor's Build menu actions (exact labels confirmed from
 * the Arma Reforger Script Editor):
 *   - "Validate Scripts"            (F7)             — validate only, fast
 *   - "Validate and Reload Scripts" (Shift+F7)       — validate + hot-reload (~15s)
 *   - "Reload Scripts"              (Ctrl+Shift+F7)  — reload only
 * Called via NET API TCP protocol: APIFunc = "EMCP_WB_Reload"
 *
 * target: "validate" -> Validate Scripts ; anything else -> Validate and Reload Scripts.
 *
 * KEEP THIS VERSION. Upstream v0.12.0 ships a different Reload.c that *guesses* the
 * menu path ("Script > Compile", then "Build > Compile All"), neither of which exists
 * in this Script Editor. Ours uses the confirmed labels. If you ever re-copy the
 * handlers from enfusion-mcp-BK-src/mod/, this file WILL be overwritten - restore it.
 *
 * This handler is also what makes headless compiling possible: wb_compile's
 * trigger "netapi" calls it instead of synthesising Shift+F7, so a build can run with
 * the Windows session LOCKED (SetForegroundWindow is refused then, so the keyboard
 * path cannot work at all). See src/utils/wb-trigger.ts.
 *
 * NOTE: driving the reload from inside the script VM leaves the structs below alive
 * when that VM is torn down, which the engine reports as leaked script instances —
 * expected, not a defect. It also means the TCP reply usually never arrives: callers
 * must treat that timeout as success and read the verdict from the console log and
 * the Errors pane.
 */

class EMCP_WB_ReloadRequest : JsonApiStruct
{
	string target;

	void EMCP_WB_ReloadRequest()
	{
		RegV("target");
	}
}

class EMCP_WB_ReloadResponse : JsonApiStruct
{
	string status;
	string message;

	void EMCP_WB_ReloadResponse()
	{
		RegV("status");
		RegV("message");
	}
}

class EMCP_WB_Reload : NetApiHandler
{
	override JsonApiStruct GetRequest()
	{
		return new EMCP_WB_ReloadRequest();
	}

	override JsonApiStruct GetResponse(JsonApiStruct request)
	{
		EMCP_WB_ReloadRequest req = EMCP_WB_ReloadRequest.Cast(request);
		EMCP_WB_ReloadResponse resp = new EMCP_WB_ReloadResponse();

		ScriptEditor scriptEditor = Workbench.GetModule(ScriptEditor);
		if (!scriptEditor)
		{
			resp.status = "error";
			resp.message = "ScriptEditor module not available";
			return resp;
		}

		string action = "Validate and Reload Scripts";
		if (req.target == "validate")
			action = "Validate Scripts";

		array<string> menuPath = {"Build", action};
		bool ok = scriptEditor.ExecuteAction(menuPath);

		resp.status = "ok";
		resp.message = "Build > " + action + " (ExecuteAction=" + ok.ToString() + ")";
		return resp;
	}
}
