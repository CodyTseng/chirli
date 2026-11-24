import { configureNotes } from "./notes-handler.js";
import { runLive } from "./runtime.js";

await runLive(
	"notes",
	"Send /remember <text>, /notes or /help. Notes use your local DM history.",
	configureNotes,
);
