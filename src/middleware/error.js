function notFound(req, res) {
  res.status(404).json({ error: 'Not found' });
}

/**
 * Anything a controller deliberately rejects sets `err.status` (or answers
 * directly), and its message is written for the user — pass that through.
 *
 * An error with NO status is an unhandled crash. Its message is written for us,
 * not for them: a raw Postgres constraint string, a stack-trace-ish internal, a
 * driver message that names our tables. Those used to be echoed verbatim and
 * ended up in a vendor's browser alert ("violates RESTRICT setting of foreign
 * key constraint transactions_gateway_id_fkey on table transactions"). Log the
 * real thing, return something neutral.
 */
function errorHandler(err, req, res, _next) {
  console.error(err);
  const status = err.status || 500;
  const message = status >= 500
    ? 'Something went wrong on our side. Please try again.'
    : (err.message || 'Request failed');
  res.status(status).json({ error: message });
}

module.exports = { notFound, errorHandler };
