/* api/router.js — catch-all API-router (enige serverless function).
   /api/<route> → dispatch naar de handler. De handler staat onder
   underscore-prefix (_spraakbericht) zodat Vercel hem NIET als losse
   route/functie behandelt — alleen router.js is de function. */
module.exports = async (req, res) => {
  try {
    return await require("./_spraakbericht")(req, res);
  } catch (err) {
    console.error("[api]", err);
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(500).json({ error: "interne fout" });
  }
};
