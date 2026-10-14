/**
 * Declenchement d'un "Build > Validate and Reload Scripts" SANS clavier.
 *
 * POURQUOI : wb_compile synthetisait Shift+F7 (wb-keys.ts). Windows interdit
 * SetForegroundWindow quand la session est verrouillee (LogonUI actif), donc la touche
 * n'etait jamais envoyee et l'outil renvoyait "no_focus" : impossible de compiler en
 * l'absence de l'utilisateur.
 *
 * Le NET API du Workbench, lui, repond meme session verrouillee (verifie), et notre
 * handler EMCP_WB_Reload appelle
 *   ScriptEditor.ExecuteAction({"Build", "Validate and Reload Scripts"})
 * ce qui est exactement la meme action de menu que Shift+F7, commandee depuis
 * l'interieur du process. Aucun focus requis, et aucun vol de focus a l'utilisateur.
 *
 * PARTICULARITE : ExecuteAction est synchrone et le hot-reload detruit le VM script
 * qui porte le handler. La reponse TCP n'arrive donc souvent JAMAIS. Un timeout ici
 * n'est PAS une erreur : la commande a ete honoree. Le verdict se lit ensuite dans le
 * console.log et dans l'Errors pane, comme avant.
 */

import net from "node:net";

const HOST = "127.0.0.1";
const PORT = 5775;

export type TriggerResult =
  | { result: "sent"; detail: string }
  | { result: "error"; detail: string };

function pascal(s: string): Buffer {
  const body = Buffer.from(s, "utf-8");
  const len = Buffer.alloc(4);
  len.writeInt32LE(body.length, 0);
  return Buffer.concat([len, body]);
}

/**
 * Demande le validate+reload via le NET API.
 *
 * @param waitMs Delai laisse au handler pour repondre avant de considerer que le VM a
 *               ete recharge (cas nominal). Ne pas descendre sous ~15s : le reload est
 *               synchrone et prend une dizaine de secondes.
 */
export function triggerValidateAndReload(waitMs = 20_000): Promise<TriggerResult> {
  return new Promise((resolve) => {
    const version = Buffer.alloc(4);
    version.writeInt32LE(1, 0);
    const payload = JSON.stringify({ target: "reload", APIFunc: "EMCP_WB_Reload" });
    const req = Buffer.concat([
      version,
      pascal("enfusion-mcp-compile"),
      pascal("JsonRPC"),
      pascal(payload),
    ]);

    let settled = false;
    const done = (r: TriggerResult) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* socket deja ferme */
      }
      resolve(r);
    };

    const sock = net.createConnection({ host: HOST, port: PORT }, () => sock.write(req));

    // Pas de reponse = le VM a ete recharge pendant l'appel : c'est le cas nominal.
    const timer = setTimeout(
      () => done({ result: "sent", detail: "commande envoyee (VM recharge avant reponse)" }),
      waitMs,
    );

    sock.on("end", () => {
      clearTimeout(timer);
      done({ result: "sent", detail: "handler EMCP_WB_Reload a repondu" });
    });

    sock.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (e.code === "ECONNREFUSED") {
        done({
          result: "error",
          detail:
            `NET API injoignable sur ${HOST}:${PORT}. Le Workbench est-il lance, et l'addon ` +
            `EnfusionMCP active (ses handlers doivent compiler pour s'enregistrer) ?`,
        });
        return;
      }
      done({ result: "error", detail: e.message });
    });
  });
}
