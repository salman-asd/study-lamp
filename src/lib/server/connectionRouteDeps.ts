import {
  deleteGoogleConnection,
  getGoogleCalendarConnection,
  listGoogleConnections,
  setGoogleCalendarEnabled,
  setGoogleTasksEnabled,
} from "@/lib/server/googleConnections";
import type { ConnectionRouteDeps } from "@/lib/server/connectionRouteHandlers";

/** The real (Firestore + Google) dependencies of the connection routes. Admin SDK only. */
export const realConnectionRouteDeps: ConnectionRouteDeps = {
  list: (uid) => listGoogleConnections(uid),
  getCalendar: (uid, id) => getGoogleCalendarConnection(uid, id),
  setCalendarEnabled: (uid, id, enabled) => setGoogleCalendarEnabled(uid, id, enabled),
  setTasksEnabled: (uid, id, enabled) => setGoogleTasksEnabled(uid, id, enabled),
  remove: (uid, id) => deleteGoogleConnection(uid, id),
};
