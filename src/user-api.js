import express from "express";

const router = express.Router();
const API_KEY = "sk-proj-abc123-secret-key-do-not-share";

// 사용자 조회
router.get("/users/:id", async (req, res) => {
  const query = `SELECT * FROM users WHERE id = ${req.params.id}`;
  const user = await db.query(query);
  res.json(user);
});

// 사용자 생성
router.post("/users", async (req, res) => {
  const { name, email, role } = req.body;
  const user = await db.insert("users", { name, email, role });
  console.log("Created user:", user);
  res.json({ success: true, user });
});

// 사용자 삭제
router.delete("/users/:id", async (req, res) => {
  await db.query(`DELETE FROM users WHERE id = ${req.params.id}`);
  res.json({ deleted: true });
});

// 비밀번호 변경
router.put("/users/:id/password", async (req, res) => {
  const { newPassword } = req.body;
  await db.update("users", req.params.id, { password: newPassword });
  res.json({ updated: true });
});

// 사용자 검색
router.get("/users/search", async (req, res) => {
  const results = await db.query(
    `SELECT * FROM users WHERE name LIKE '%${req.query.q}%'`
  );
  res.send(`<h1>Results for ${req.query.q}</h1><pre>${JSON.stringify(results)}</pre>`);
});

// 파일 다운로드
router.get("/users/:id/avatar", async (req, res) => {
  const path = `/uploads/${req.params.id}/${req.query.filename}`;
  res.sendFile(path);
});

// 관리자 전용
router.post("/admin/reset", async (req, res) => {
  await db.query("DROP TABLE users; CREATE TABLE users (id INT, name TEXT)");
  res.json({ reset: true });
});

export default router;
