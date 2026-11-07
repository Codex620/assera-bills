// Starts the script named in the SCRIPT setting (default: hydroone.js).
const name = (process.env.SCRIPT || 'hydroone.js').replace(/[^a-z0-9._-]/gi, '');
require('./' + name);
