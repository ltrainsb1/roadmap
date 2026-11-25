/* global db -- the mongosh global */
// Creates the user the API and the worker connect as: readWrite on the app's own database, nothing else (no
// listDatabases, no other database, no user management). The root account stays for backups and maintenance.
//
// The MongoDB image runs this once, on a fresh data folder only (after the root user exists). On a server whose data
// folder already exists it does not run: create the user by hand there with the same command.
const dbName = process.env.MONGO_DB;
const password = process.env.MONGO_APP_PASSWORD;
if (!dbName) throw new Error('MONGO_DB is empty');
if (!password) throw new Error('MONGO_APP_PASSWORD is empty');

db.getSiblingDB(dbName).createUser({
  user: 'roadmap_app',
  pwd: password,
  roles: [{ role: 'readWrite', db: dbName }],
});
