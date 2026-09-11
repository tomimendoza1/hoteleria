import app from "./server.js";
const port = Number(process.env.PORT || 3008);
app.listen(port, () => console.log(`Hotel listo en http://localhost:${port}`));
