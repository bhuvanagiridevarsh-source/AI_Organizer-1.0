module.exports = function handler(req, res) {
  return res.status(200).json({ ok: true, service: "system-janitor-backend" });
};
