#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>

// ===================== PCA9685 =====================
Adafruit_PWMServoDriver pca = Adafruit_PWMServoDriver(0x40);

// ESP32 I2C
static const int SDA_PIN = 21;
static const int SCL_PIN = 22;

static const uint16_t SERVO_FREQ = 50;   // Hz
static const uint8_t  SERVO_COUNT = 7;   // canales 0..6

// ===================== PINES BANDA + SENSOR =====================
// Puente H típico (L298N / TB6612 usando IN1/IN2 + PWM)
//
// Cambia estos pines según tu conexión real:
#define MOTOR_PWM_PIN   25   // ENA (L298N) / PWM (TB6612)
#define MOTOR_IN1_PIN   18   // IN1
#define MOTOR_IN2_PIN   19   // IN2

// Sensor de objeto (IR, barrera, etc.)
#define SENSOR_PIN      35

// Lógica del sensor: algunos sensores dan LOW cuando detectan.
#define SENSOR_ACTIVE_LOW  true   // true: detecta cuando lee LOW; false: detecta cuando lee HIGH

// ===================== PWM ESP32 (core 3.x) =====================
// En core 3.3.x ya no se usa ledcSetup/ledcAttachPin.
// Se usa: ledcAttach(pin, freq, res) y ledcWrite(pin, duty)
static const int PWM_FREQ = 20000;  // 20 kHz
static const int PWM_RES  = 8;      // 0..255

// ===================== SUAVIDAD SERVOS =====================
int stepDeg = 1;        // 1° = más suave
int stepDelayMs = 25;   // más alto = más lento

// Estado actual estimado
int currentAngle[SERVO_COUNT] = {90, 90, 90, 90, 90, 90, 90};

// ===================== RANGOS POR CANAL (microsegundos) =====================
uint16_t usMin[SERVO_COUNT] = {
  500,  // CH0 MG996R
  600,  // CH1 TD8835MG
  600,  // CH2 DS3218
  500,  // CH3 MG996R
  500,  // CH4 MG996R
  500,  // CH5 MG996R
  500   // CH6 MG996R (gripper)
};

uint16_t usMax[SERVO_COUNT] = {
  2600, // CH0 MG996R
  2600, // CH1 TD8835MG
  2150, // CH2 DS3218
  2600, // CH3 MG996R
  2600, // CH4 MG996R
  2600, // CH5 MG996R
  2600  // CH6 MG996R (gripper)
};

// Límites de seguridad del sistema
static const uint16_t US_HARD_MIN = 400;
static const uint16_t US_HARD_MAX = 2600;

// ===================== ESTADO BANDA / AUTO =====================
bool autoEnabled = false;      // si true: el sensor puede disparar TRIGGER
bool triggerLatched = false;   // evita spam de TRIGGER mientras el objeto está presente

int bandSpeed = 170;           // 0..255 (default)
bool bandRunning = false;

// ===================== UTILIDADES PCA =====================
uint16_t usToTick(uint16_t us) {
  // 50 Hz => 20000 us por periodo
  uint32_t tick = (uint32_t)us * 4096UL / 20000UL;
  if (tick > 4095) tick = 4095;
  return (uint16_t)tick;
}

void setServoUs(uint8_t ch, uint16_t us) {
  if (us < US_HARD_MIN) us = US_HARD_MIN;
  if (us > US_HARD_MAX) us = US_HARD_MAX;
  pca.setPWM(ch, 0, usToTick(us));
}

uint16_t angleToUs(uint8_t ch, float angleDeg) {
  angleDeg = constrain(angleDeg, 0.0f, 180.0f);
  uint16_t mn = usMin[ch];
  uint16_t mx = usMax[ch];
  float us = mn + (angleDeg / 180.0f) * (mx - mn);
  return (uint16_t)(us + 0.5f);
}

void setServoAngle(uint8_t ch, float angleDeg) {
  setServoUs(ch, angleToUs(ch, angleDeg));
}

// Mover todos suavemente a 7 ángulos (bloqueante, compatible con tu web actual)
void moveServosSmooth(const int targetAngles[SERVO_COUNT]) {
  int target[SERVO_COUNT];
  for (uint8_t i = 0; i < SERVO_COUNT; i++) {
    target[i] = constrain(targetAngles[i], 0, 180);
  }

  int step = max(1, abs(stepDeg));

  bool anyMoving = true;
  while (anyMoving) {
    anyMoving = false;

    for (uint8_t ch = 0; ch < SERVO_COUNT; ch++) {
      int diff = target[ch] - currentAngle[ch];
      if (diff != 0) {
        anyMoving = true;

        int delta = (abs(diff) < step) ? abs(diff) : step;
        currentAngle[ch] += (diff > 0) ? delta : -delta;

        setServoAngle(ch, currentAngle[ch]);
      }
    }

    if (anyMoving) delay(stepDelayMs);
  }
}

// ===================== UTILIDADES BANDA =====================
void motorStop() {
  digitalWrite(MOTOR_IN1_PIN, LOW);
  digitalWrite(MOTOR_IN2_PIN, LOW);
  ledcWrite(MOTOR_PWM_PIN, 0);     // core 3.x
  bandRunning = false;
}

void motorRunForward(uint8_t pwm) {
  digitalWrite(MOTOR_IN1_PIN, HIGH);
  digitalWrite(MOTOR_IN2_PIN, LOW);
  ledcWrite(MOTOR_PWM_PIN, pwm);   // core 3.x
  bandRunning = (pwm > 0);
}

bool sensorDetected() {
  int v = digitalRead(SENSOR_PIN);
  bool active = SENSOR_ACTIVE_LOW ? (v == LOW) : (v == HIGH);
  return active;
}

// ===================== SERIAL =====================
String line;

void showRanges() {
  Serial.println("\nRangos por canal (usMin..usMax):");
  Serial.println("  CH0 MG996R, CH1 TD8835MG, CH2 DS3218, CH3-6 MG996R");
  for (uint8_t ch = 0; ch < SERVO_COUNT; ch++) {
    Serial.print("CH"); Serial.print(ch);
    Serial.print(": "); Serial.print(usMin[ch]);
    Serial.print(".."); Serial.println(usMax[ch]);
  }
}

void printHelp() {
  Serial.println();
  Serial.println("=== Servo ===");
  Serial.println("  <a0> <a1> <a2> <a3> <a4> <a5> <a6>        (7 angulos 0..180)");
  Serial.println("  zero                                      (todos a 0)");
  Serial.println("  center                                    (todos a 90)");
  Serial.println("  test                                      (0->90->180->90)");
  Serial.println("  speed <stepDeg> <delayMs>                 (ej: speed 1 25)");
  Serial.println("  us <ch> <microsegundos>                   (pulso directo)");
  Serial.println("  range <ch> <usMin> <usMax>                (calibrar rango)");
  Serial.println("  show                                      (muestra rangos)");
  Serial.println();
  Serial.println("=== Banda (motor DC) ===");
  Serial.println("  band run                                  (enciende banda con velocidad actual)");
  Serial.println("  band stop                                 (detiene banda)");
  Serial.println("  band speed <0..255>                       (ajusta velocidad)");
  Serial.println("  band status                               (estado de banda)");
  Serial.println();
  Serial.println("=== Auto / Sensor ===");
  Serial.println("  auto on                                   (habilita TRIGGER por sensor)");
  Serial.println("  auto off                                  (deshabilita TRIGGER por sensor)");
  Serial.println("  auto status                               (estado auto/sensor)");
  Serial.println("  trigger                                   (simula TRIGGER)");
  Serial.println();
  Serial.println("=== Otros ===");
  Serial.println("  ping                                      (PONG)");
  Serial.println("  state                                     (estado general)");
  Serial.println();
}

bool parseSevenAngles(const char *cstr, int outAngles[SERVO_COUNT]) {
  char buf[128];
  size_t n = strnlen(cstr, sizeof(buf) - 1);
  memcpy(buf, cstr, n);
  buf[n] = '\0';

  uint8_t count = 0;
  char *token = strtok(buf, " ,\t");
  while (token != nullptr && count < SERVO_COUNT) {
    char *endptr = nullptr;
    long v = strtol(token, &endptr, 10);
    if (endptr == token) return false;
    outAngles[count++] = (int)v;
    token = strtok(nullptr, " ,\t");
  }
  return (count == SERVO_COUNT);
}

void doTest() {
  Serial.println("TEST: moviendo 0 -> 90 -> 180 -> 90");
  int a0[SERVO_COUNT] = {0,0,0,0,0,0,0};
  int a1[SERVO_COUNT] = {90,90,90,90,90,90,90};
  int a2[SERVO_COUNT] = {180,180,180,180,180,180,180};

  moveServosSmooth(a0); delay(200);
  moveServosSmooth(a1); delay(200);
  moveServosSmooth(a2); delay(200);
  moveServosSmooth(a1);

  Serial.println("TEST OK");
}

void printState() {
  Serial.print("STATE angles=");
  for (uint8_t i = 0; i < SERVO_COUNT; i++) {
    Serial.print(currentAngle[i]);
    if (i < SERVO_COUNT - 1) Serial.print(",");
  }
  Serial.print(" band=");
  Serial.print(bandRunning ? "ON" : "OFF");
  Serial.print(" speed=");
  Serial.print(bandSpeed);
  Serial.print(" auto=");
  Serial.print(autoEnabled ? "ON" : "OFF");
  Serial.print(" sensor=");
  Serial.println(sensorDetected() ? "1" : "0");
}

void handleCommand(String s) {
  s.trim();
  if (s.length() == 0) return;

  // --- básicos ---
  if (s.equalsIgnoreCase("help")) { printHelp(); return; }
  if (s.equalsIgnoreCase("show")) { showRanges(); return; }
  if (s.equalsIgnoreCase("ping")) { Serial.println("PONG"); return; }
  if (s.equalsIgnoreCase("state")) { printState(); return; }

  // --- servo presets ---
  if (s.equalsIgnoreCase("zero")) {
    int z[SERVO_COUNT] = {0,0,0,0,0,0,0};
    Serial.println("Moviendo todos a 0...");
    moveServosSmooth(z);
    Serial.println("OK");
    return;
  }
  if (s.equalsIgnoreCase("center")) {
    int c[SERVO_COUNT] = {90,90,90,90,90,90,90};
    Serial.println("Moviendo todos a 90...");
    moveServosSmooth(c);
    Serial.println("OK");
    return;
  }
  if (s.equalsIgnoreCase("test")) { doTest(); return; }

  // --- speed ---
  if (s.startsWith("speed")) {
    int a,b;
    if (sscanf(s.c_str(), "speed %d %d", &a, &b) == 2) {
      stepDeg = max(1, abs(a));
      stepDelayMs = max(0, b);
      Serial.print("OK: stepDeg="); Serial.print(stepDeg);
      Serial.print(" stepDelayMs="); Serial.println(stepDelayMs);
    } else {
      Serial.println("Formato: speed <stepDeg> <delayMs>");
    }
    return;
  }

  // --- us ---
  if (s.startsWith("us")) {
    int ch, us;
    if (sscanf(s.c_str(), "us %d %d", &ch, &us) == 2) {
      if (ch < 0 || ch >= SERVO_COUNT) { Serial.println("ERROR: ch debe ser 0..6"); return; }
      Serial.print("CH"); Serial.print(ch); Serial.print(" -> "); Serial.print(us); Serial.println(" us");
      setServoUs((uint8_t)ch, (uint16_t)us);
      Serial.println("OK");
    } else {
      Serial.println("Formato: us <ch> <microsegundos>");
    }
    return;
  }

  // --- range ---
  if (s.startsWith("range")) {
    int ch, mn, mx;
    if (sscanf(s.c_str(), "range %d %d %d", &ch, &mn, &mx) == 3) {
      if (ch < 0 || ch >= SERVO_COUNT) { Serial.println("ERROR: ch debe ser 0..6"); return; }
      if (mn < (int)US_HARD_MIN) mn = US_HARD_MIN;
      if (mx > (int)US_HARD_MAX) mx = US_HARD_MAX;
      if (mn >= mx) { Serial.println("ERROR: usMin debe ser menor que usMax"); return; }

      usMin[ch] = (uint16_t)mn;
      usMax[ch] = (uint16_t)mx;

      Serial.print("OK: CH"); Serial.print(ch);
      Serial.print(" range "); Serial.print(usMin[ch]);
      Serial.print(".."); Serial.println(usMax[ch]);
    } else {
      Serial.println("Formato: range <ch> <usMin> <usMax>");
    }
    return;
  }

  // ===================== BANDA =====================
  if (s.equalsIgnoreCase("band stop")) {
    motorStop();
    Serial.println("OK BAND STOP");
    return;
  }

  if (s.equalsIgnoreCase("band run")) {
    motorRunForward((uint8_t)constrain(bandSpeed, 0, 255));
    Serial.print("OK BAND RUN speed=");
    Serial.println(bandSpeed);
    return;
  }

  if (s.startsWith("band speed")) {
    int sp;
    if (sscanf(s.c_str(), "band speed %d", &sp) == 1) {
      bandSpeed = constrain(sp, 0, 255);
      Serial.print("OK BAND SPEED=");
      Serial.println(bandSpeed);
    } else {
      Serial.println("Formato: band speed <0..255>");
    }
    return;
  }

  if (s.equalsIgnoreCase("band status")) {
    Serial.print("BAND ");
    Serial.print(bandRunning ? "ON" : "OFF");
    Serial.print(" speed=");
    Serial.println(bandSpeed);
    return;
  }

  // ===================== AUTO / SENSOR =====================
  if (s.equalsIgnoreCase("auto on")) {
    autoEnabled = true;
    triggerLatched = false;
    Serial.println("OK AUTO ON");
    return;
  }

  if (s.equalsIgnoreCase("auto off")) {
    autoEnabled = false;
    triggerLatched = false;
    Serial.println("OK AUTO OFF");
    return;
  }

  if (s.equalsIgnoreCase("auto status")) {
    Serial.print("AUTO ");
    Serial.print(autoEnabled ? "ON" : "OFF");
    Serial.print(" sensor=");
    Serial.print(sensorDetected() ? "1" : "0");
    Serial.print(" latched=");
    Serial.println(triggerLatched ? "1" : "0");
    return;
  }

  if (s.equalsIgnoreCase("trigger")) {
    motorStop();
    Serial.println("TRIGGER");
    Serial.println("OK");
    return;
  }

  // ===================== 7 ÁNGULOS =====================
  int angles[SERVO_COUNT];
  if (!parseSevenAngles(s.c_str(), angles)) {
    Serial.println("No entendi. Envia 7 angulos o 'help'.");
    return;
  }

  Serial.print("Moviendo a: ");
  for (uint8_t i = 0; i < SERVO_COUNT; i++) {
    Serial.print(constrain(angles[i], 0, 180));
    Serial.print(i == SERVO_COUNT - 1 ? "\n" : " ");
  }

  moveServosSmooth(angles);
  Serial.println("OK");
}

void setup() {
  Serial.begin(115200);
  delay(200);

  // I2C
  Wire.begin(SDA_PIN, SCL_PIN);

  if (!pca.begin()) {
    Serial.println("ERROR: No se detecta PCA9685. Revisa I2C, GND y direccion 0x40.");
    while (true) delay(1000);
  }
  pca.setPWMFreq(SERVO_FREQ);
  delay(10);

  // Inicializa servos a 90°
  for (uint8_t ch = 0; ch < SERVO_COUNT; ch++) {
    currentAngle[ch] = 90;
    setServoAngle(ch, 90);
    delay(60);
  }

  // Motor pins
  pinMode(MOTOR_IN1_PIN, OUTPUT);
  pinMode(MOTOR_IN2_PIN, OUTPUT);
  digitalWrite(MOTOR_IN1_PIN, LOW);
  digitalWrite(MOTOR_IN2_PIN, LOW);

  // PWM motor (ESP32 core 3.x)
  ledcAttach(MOTOR_PWM_PIN, PWM_FREQ, PWM_RES);
  ledcWrite(MOTOR_PWM_PIN, 0);

  // Sensor
  pinMode(SENSOR_PIN, INPUT); // si tu sensor requiere pullup: INPUT_PULLUP (y ajusta SENSOR_ACTIVE_LOW)
  triggerLatched = false;

  Serial.println("Listo. WebSerial 115200.");
  Serial.println("Comandos: 'help' para lista.");
  showRanges();

  Serial.println("OK READY");
}

void loop() {
  // 1) SENSOR -> TRIGGER (solo si autoEnabled)
  if (autoEnabled) {
    bool det = sensorDetected();

    // latch por flanco para no spamear
    if (det && !triggerLatched) {
      triggerLatched = true;

      // Detener banda inmediatamente
      motorStop();

      // Aviso a la web
      Serial.println("TRIGGER");
    }

    // Rearmar cuando ya no hay objeto
    if (!det && triggerLatched) {
      triggerLatched = false;
      Serial.println("CLEAR");
    }
  }

  // 2) SERIAL RX
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n') {
      handleCommand(line);
      line = "";
    } else if (c != '\r') {
      if (line.length() < 200) line += c;
    }
  }
}
