const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();

// Подключение к БД
console.log('🔍 Подключение к БД...');
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

pool.connect((err) => {
  if (err) {
    console.error(' Ошибка БД:', err.message);
  } else {
    console.log(' БД подключена');
  }
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// Главная страница - перенаправление на indexx.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'indexx.html'));
});

// Middleware для CORS и CSP
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src *; style-src * 'unsafe-inline'; script-src * 'unsafe-inline' 'unsafe-eval'; img-src * data:; connect-src *;");
  next();
});
// ============= ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =============
function safeString(str) {
  if (str === null || str === undefined) return '';
  try {
    return String(str);
  } catch (e) {
    return '';
  }
}

// ============= АУТЕНТИФИКАЦИЯ =============

// Вход
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log('🔑 Попытка входа:', email);

    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    const user = result.rows[0];
    
    // Для теста принимаем пароль 123456
    if (password !== '123456') {
      return res.status(401).json({ error: 'Неверный пароль' });
    }

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        full_name: safeString(user.full_name)
      },
      process.env.JWT_SECRET || 'secret-key-2026',
      { expiresIn: '24h' }
    );

    console.log('✅ Успешный вход. Роль:', user.role);

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        full_name: safeString(user.full_name),
        role: user.role
      }
    });

  } catch (error) {
    console.error('Ошибка входа:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Регистрация
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, full_name, phone } = req.body;

    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Email уже используется' });
    }

    const result = await pool.query(
      `INSERT INTO users (id, org_id, email, password_hash, full_name, role, is_active, phone) 
       VALUES (gen_random_uuid(), '8ce35410-107e-43c8-9207-0e0bdea463a2', $1, $2, $3, 'customer', true, $4)
       RETURNING id, email, full_name, role`,
      [email, 'hash', full_name, phone]
    );

    res.status(201).json({
      message: 'Регистрация успешна',
      user: result.rows[0]
    });

  } catch (error) {
    console.error('Ошибка регистрации:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============= ПРОФИЛЬ КЛИЕНТА =============

// Получение профиля клиента
app.get('/api/client/profile', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Нет токена' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret-key-2026');
    
    const result = await pool.query(
      `SELECT id, full_name, email, phone, created_at
       FROM users WHERE id = $1`,
      [decoded.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const user = result.rows[0];
    
    // Получаем статистику записей
    const stats = await pool.query(
      `SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN status IN ('pending', 'confirmed') THEN 1 END) as active,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed
       FROM appointments 
       WHERE customer_id = $1`,
      [decoded.id]
    );

    res.json({
      profile: {
        id: user.id,
        full_name: safeString(user.full_name),
        email: safeString(user.email),
        phone: safeString(user.phone) || '+7 (999) 123-45-67',
        registered_at: user.created_at
      },
      stats: {
        total: parseInt(stats.rows[0].total) || 0,
        active: parseInt(stats.rows[0].active) || 0,
        completed: parseInt(stats.rows[0].completed) || 0
      }
    });

  } catch (error) {
    console.error('Ошибка профиля:', error);
    res.status(403).json({ error: 'Недействительный токен' });
  }
});

// ============= ЗАПИСИ КЛИЕНТА =============

// Получение активных записей клиента
app.get('/api/client/appointments', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Нет токена' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret-key-2026');

    const result = await pool.query(
      `SELECT 
        a.id,
        a.start_at,
        a.end_at,
        a.status,
        s.title as service_name,
        s.base_price,
        u.full_name as staff_name,
        o.name as organization_name
      FROM appointments a
      JOIN services s ON s.id = a.service_id
      JOIN users u ON u.id = a.staff_id
      JOIN organizations o ON o.id = a.org_id
      WHERE a.customer_id = $1 
        AND a.status IN ('pending', 'confirmed')
      ORDER BY a.start_at ASC`,
      [decoded.id]
    );

    res.json({
      appointments: result.rows.map(apt => ({
        id: apt.id,
        service: safeString(apt.service_name),
        staff: safeString(apt.staff_name),
        organization: safeString(apt.organization_name),
        date: new Date(apt.start_at).toLocaleDateString('ru-RU'),
        time: new Date(apt.start_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
        end_time: new Date(apt.end_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
        price: apt.base_price,
        status: apt.status === 'pending' ? 'Ожидание' : 'Подтверждено'
      }))
    });

  } catch (error) {
    console.error('Ошибка получения записей:', error);
    res.json({ appointments: [] });
  }
});

// Получение истории записей клиента
app.get('/api/client/history', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Нет токена' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret-key-2026');
    const { page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;

    const result = await pool.query(
      `SELECT 
        a.id,
        a.start_at,
        a.status,
        s.title as service_name,
        s.base_price,
        u.full_name as staff_name,
        to_char(a.start_at, 'DD.MM.YYYY') as date
      FROM appointments a
      JOIN services s ON s.id = a.service_id
      JOIN users u ON u.id = a.staff_id
      WHERE a.customer_id = $1 
        AND a.status IN ('completed', 'cancelled')
      ORDER BY a.start_at DESC
      LIMIT $2 OFFSET $3`,
      [decoded.id, limit, offset]
    );

    const countResult = await pool.query(
      `SELECT COUNT(*) as total 
       FROM appointments 
       WHERE customer_id = $1 AND status IN ('completed', 'cancelled')`,
      [decoded.id]
    );

    const total = parseInt(countResult.rows[0].total);

    res.json({
      history: result.rows.map((item, index) => ({
        number: `№${(offset + index + 1)}`,
        id: item.id,
        specialist: safeString(item.staff_name),
        service: safeString(item.service_name),
        date: item.date,
        status: item.status === 'completed' ? 'Выполнен' : 'Отменён',
        status_class: item.status === 'completed' ? 'completed' : 'cancelled',
        amount: `${item.base_price} руб.`
      })),
      pagination: {
        current_page: parseInt(page),
        total_pages: Math.ceil(total / limit),
        total_items: total,
        has_more: offset + result.rows.length < total
      }
    });

  } catch (error) {
    console.error('Ошибка истории:', error);
    res.json({ history: [], pagination: { has_more: false } });
  }
});

// Отмена записи
app.put('/api/appointments/:id/cancel', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Нет токена' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret-key-2026');
    const { id } = req.params;

    const result = await pool.query(
      `UPDATE appointments 
       SET status = 'cancelled' 
       WHERE id = $1 AND customer_id = $2 AND status IN ('pending', 'confirmed')
       RETURNING *`,
      [id, decoded.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Запись не найдена' });
    }

    res.json({ message: 'Запись отменена' });

  } catch (error) {
    console.error('Ошибка отмены:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============= СПЕЦИАЛИСТЫ И УСЛУГИ =============

// Получение списка специалистов
app.get('/api/staff', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, full_name, specialization 
       FROM users 
       WHERE role = 'staff' AND is_active = true
       ORDER BY full_name`
    );

    res.json({
      staff: result.rows.map(s => ({
        id: s.id,
        name: safeString(s.full_name),
        specialization: safeString(s.specialization) || 'Специалист'
      }))
    });

  } catch (error) {
    console.error('Ошибка:', error);
    res.json({ staff: [] });
  }
});

// Получение списка услуг
app.get('/api/services', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, base_price, duration_minutes 
       FROM services 
       WHERE is_active = true
       ORDER BY title`
    );

    res.json({
      services: result.rows.map(s => ({
        id: s.id,
        title: safeString(s.title),
        price: parseFloat(s.base_price).toFixed(2),
        duration: s.duration_minutes
      }))
    });

  } catch (error) {
    console.error('Ошибка:', error);
    res.json({ services: [] });
  }
});

// ============= СОЗДАНИЕ ЗАПИСИ =============

// Получение доступных слотов
app.get('/api/appointments/available', async (req, res) => {
  try {
    const { staff_id, date } = req.query;
    
    const appointments = await pool.query(
      `SELECT start_at FROM appointments 
       WHERE staff_id = $1 
         AND DATE(start_at) = $2
         AND status IN ('pending', 'confirmed')`,
      [staff_id, date]
    );

    const allSlots = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];
    
    const bookedHours = appointments.rows.map(apt => 
      new Date(apt.start_at).getHours().toString().padStart(2, '0') + ':00'
    );
    
    const availableSlots = allSlots.filter(slot => !bookedHours.includes(slot));

    res.json(availableSlots);

  } catch (error) {
    console.error('Ошибка получения слотов:', error);
    res.json([]);
  }
});

// Создание новой записи
app.post('/api/appointments', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Нет токена' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret-key-2026');
    const { org_id, staff_id, service_id, start_at } = req.body;

    const service = await pool.query(
      'SELECT duration_minutes FROM services WHERE id = $1',
      [service_id]
    );

    if (service.rows.length === 0) {
      return res.status(404).json({ error: 'Услуга не найдена' });
    }

    const duration = service.rows[0].duration_minutes;
    const startTime = new Date(start_at);
    const endTime = new Date(startTime.getTime() + duration * 60000);

    const conflict = await pool.query(
      `SELECT id FROM appointments 
       WHERE staff_id = $1 
         AND status IN ('pending', 'confirmed')
         AND (start_at < $3 AND end_at > $2)`,
      [staff_id, startTime, endTime]
    );

    if (conflict.rows.length > 0) {
      return res.status(409).json({ error: 'Это время уже занято' });
    }

    const result = await pool.query(
      `INSERT INTO appointments (org_id, customer_id, staff_id, service_id, start_at, end_at, status) 
       VALUES ($1, $2, $3, $4, $5, $6, 'pending') 
       RETURNING *`,
      [org_id || '8ce35410-107e-43c8-9207-0e0bdea463a2', decoded.id, staff_id, service_id, startTime, endTime]
    );

    console.log('✅ Создана новая запись для клиента:', decoded.id);

    res.status(201).json({
      message: 'Запись успешно создана',
      appointment: result.rows[0]
    });

  } catch (error) {
    console.error('Ошибка создания записи:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============= Middleware для проверки роли владельца =============
const requireOwner = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Нет токена' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret-key-2026');
    if (decoded.role !== 'owner') {
      return res.status(403).json({ error: 'Требуется роль владельца' });
    }
    req.user = decoded;
    next();
  } catch (error) {
    res.status(403).json({ error: 'Недействительный токен' });
  }
};

// ============= МАРШРУТЫ ДЛЯ ВЛАДЕЛЬЦА =============

// Получение статистики
app.get('/api/owner/stats', requireOwner, async (req, res) => {
  try {
    const staffCount = await pool.query("SELECT COUNT(*) FROM users WHERE role = 'staff'");
    const activeToday = await pool.query("SELECT COUNT(*) FROM users WHERE role = 'staff' AND is_active = true");
    const servicesCount = await pool.query("SELECT COUNT(*) FROM services");
    const newThisMonth = await pool.query(`
      SELECT COUNT(*) FROM users 
      WHERE role = 'staff' 
      AND created_at >= date_trunc('month', CURRENT_DATE)
    `);

    res.json({
      total: parseInt(staffCount.rows[0].count),
      active: parseInt(activeToday.rows[0].count),
      services: parseInt(servicesCount.rows[0].count),
      new: parseInt(newThisMonth.rows[0].count)
    });
  } catch (error) {
    console.error('Ошибка статистики:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получение списка всех сотрудников
app.get('/api/owner/staff', requireOwner, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, full_name, email, specialization, is_active, 
             to_char(created_at, 'DD.MM.YYYY') as created_at
      FROM users 
      WHERE role = 'staff'
      ORDER BY created_at DESC
    `);

    const staff = result.rows.map(row => ({
      id: row.id,
      full_name: safeString(row.full_name),
      email: safeString(row.email),
      specialization: row.specialization ? safeString(row.specialization) : null,
      is_active: row.is_active,
      created_at: row.created_at
    }));

    res.json({ staff });
  } catch (error) {
    console.error('Ошибка получения сотрудников:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получение последних сотрудников
app.get('/api/owner/staff/recent', requireOwner, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT full_name, email, specialization, 
             to_char(created_at, 'DD.MM.YYYY') as created_at
      FROM users 
      WHERE role = 'staff'
      ORDER BY created_at DESC
      LIMIT 5
    `);

    const staff = result.rows.map(row => ({
      full_name: safeString(row.full_name),
      email: safeString(row.email),
      specialization: row.specialization ? safeString(row.specialization) : null,
      created_at: row.created_at
    }));

    res.json({ staff });
  } catch (error) {
    console.error('Ошибка получения сотрудников:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Поиск сотрудников
app.get('/api/owner/staff/search', requireOwner, async (req, res) => {
  try {
    const { q } = req.query;
    const result = await pool.query(`
      SELECT id, full_name, email, specialization, is_active
      FROM users 
      WHERE role = 'staff' 
        AND (full_name ILIKE $1 OR email ILIKE $1 OR specialization ILIKE $1)
      ORDER BY full_name
    `, [`%${q}%`]);

    const staff = result.rows.map(row => ({
      id: row.id,
      full_name: safeString(row.full_name),
      email: safeString(row.email),
      specialization: row.specialization ? safeString(row.specialization) : null,
      is_active: row.is_active
    }));

    res.json({ staff });
  } catch (error) {
    console.error('Ошибка поиска:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Создание нового сотрудника
app.post('/api/owner/staff', requireOwner, async (req, res) => {
  try {
    const { full_name, email, password, specialization } = req.body;

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Email уже используется' });
    }

    const result = await pool.query(`
      INSERT INTO users (id, org_id, email, password_hash, full_name, role, specialization, is_active) 
      VALUES (gen_random_uuid(), '8ce35410-107e-43c8-9207-0e0bdea463a2', $1, $2, $3, 'staff', $4, true)
      RETURNING id, full_name, email, specialization
    `, [email, password, full_name, specialization]);

    console.log(' Создан новый сотрудник:', full_name);

    res.status(201).json({
      message: 'Сотрудник успешно создан',
      staff: result.rows[0]
    });
  } catch (error) {
    console.error('Ошибка создания сотрудника:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Изменение статуса сотрудника
app.put('/api/owner/staff/:id/status', requireOwner, async (req, res) => {
  try {
    const { id } = req.params;
    const { active } = req.body;

    await pool.query(
      'UPDATE users SET is_active = $1 WHERE id = $2 AND role = $3',
      [active, id, 'staff']
    );

    res.json({ message: `Статус изменен на ${active ? 'активен' : 'неактивен'}` });
  } catch (error) {
    console.error('Ошибка изменения статуса:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============= ТЕСТОВЫЙ МАРШРУТ =============
app.get('/api/test', (req, res) => {
  res.json({ message: ' API работает!', time: new Date().toLocaleString() });
});

// ============= ЗАПУСК СЕРВЕРА =============

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 СЕРВЕР ЗАПУЩЕН НА ПОРТУ ${PORT}`);
  console.log(`📱 Откройте браузер: http://localhost:${PORT}`);
  console.log(`\n Тестовые данные:`);
  console.log(`   Клиент: client@test.ru / 123456`);
  console.log(`   Специалист: nikolay@mail.ru / 123456`);
  console.log(`   Владелец: owner@test.ru / 123456\n`);
});