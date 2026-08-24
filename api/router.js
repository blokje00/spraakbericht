/* api/router.js — catch-all API-router (enige serverless function).
   /api/<route> → dispatch naar de juiste handler. */
module.exports = async (req, res) => {
  try {
    return await require("./spraakbericht")(req, res);
  } catch (err) {
    console.error("[api]", err);
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(500).json({ error: "interne fout" });
  }
};
