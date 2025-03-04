import {Pool} from 'pg';
import {Kafka, SASLOptions} from 'kafkajs';
import {helperAntennas, mainAntennas} from './data';

const antennasEventsTopicName = 'antennas_performance';
const antennasTopic = 'antennas';

const brokers = [process.env.KAFKA_BROKER || 'localhost:9092'];
const sasl: SASLOptions = {
  username: process.env.KAFKA_USERNAME || 'admin',
  password: process.env.KAFKA_PASSWORD || 'admin-secret',
  mechanism: process.env.KAFKA_SASL_MECHANISM as any || 'scram-sha-256',
};

const kafka = new Kafka({
  clientId: 'kafkaClient',
  brokers,
  sasl: sasl,
  ssl: true,
});

const producer = kafka.producer();

/**
 * Create Materialize sources and materialized views
 * Before creating the views it will check if they aren't created already.
 */
/**
 * Materialize Client
 */
 const mzHost = process.env.MZ_HOST || 'materialized';
 const mzPort = Number(process.env.MZ_PORT) || 6875;
 const mzUser = process.env.MZ_USER || 'materialize';
 const mzPassword = process.env.MZ_PASSWORD || 'materialize';
 const mzDatabase = process.env.MZ_DATABASE || 'materialize';
async function setUpMaterialize() {
  console.log('Setting up Materialize...');
  const pool = await new Pool({
    host: mzHost,
    port: mzPort,
    user: mzUser,
    password: mzPassword,
    database: mzDatabase,
    ssl: true,
  });
  const poolClient = await pool.connect();
  await poolClient.query(`
    CREATE SECRET  IF NOT EXISTS up_sasl_username AS '${process.env.KAFKA_USERNAME }';
  `);
  await poolClient.query(`
    CREATE SECRET  IF NOT EXISTS up_sasl_password AS '${process.env.KAFKA_PASSWORD }';
  `);
  await poolClient.query(`
    CREATE CONNECTION IF NOT EXISTS upstash_kafka
      FOR KAFKA
      BROKER '${brokers}',
      SASL MECHANISMS = 'SCRAM-SHA-256',
      SASL USERNAME = SECRET up_sasl_username,
      SASL PASSWORD = SECRET up_sasl_password;
  `);
  await poolClient.query(`
    CREATE SOURCE IF NOT EXISTS antennas_performance
      FROM KAFKA CONNECTION upstash_kafka (TOPIC '${antennasEventsTopicName}')
      FORMAT BYTES
      WITH (SIZE 'xsmall');
  `);

  await poolClient.query(`
    CREATE SOURCE IF NOT EXISTS antennas
      FROM KAFKA CONNECTION upstash_kafka (TOPIC '${antennasTopic}')
      FORMAT BYTES
      WITH (SIZE 'xsmall');
  `);

  const {rowCount} = await pool.query(
    "SHOW sources WHERE name='last_minute_antennas_performance' OR name='parsed_antennas';"
  );

  if (!rowCount) {
    await poolClient.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS last_minute_antennas_performance AS
      SELECT
        CAST(parsed_data->'antenna_id' AS INT) as antenna_id,
        CAST(parsed_data->'clients_connected' AS INT) as clients_connected,
        CAST(parsed_data->'performance' AS NUMERIC) as performance,
        CAST(parsed_data->'updated_at' AS NUMERIC) as updated_at
      FROM (
        -- Parse data from Kafka
        SELECT
          CAST (data AS jsonb) AS parsed_data
        FROM (
          SELECT convert_from(data, 'utf8') AS data
          FROM antennas_performance
        )
      )
      WHERE ((CAST(parsed_data->'updated_at' AS NUMERIC)) + 60000) > mz_now();
    `);

    await poolClient.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS parsed_antennas AS
      SELECT
        CAST(parsed_data->'antenna_id' AS INT) as antenna_id,
        CAST(parsed_data->'geojson' AS JSONB) as geojson
      FROM (
        -- Parse data from Kafka
        SELECT
          CAST (data AS jsonb) AS parsed_data
        FROM (
          SELECT convert_from(data, 'utf8') AS data
          FROM antennas
        )
      );
    `);

    await poolClient.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS last_half_minute_performance_per_antenna AS
      SELECT A.antenna_id, A.geojson, AVG(performance) as performance
      FROM parsed_antennas A JOIN last_minute_antennas_performance AP ON (A.antenna_id = AP.antenna_id)
      WHERE (AP.updated_at + 30000) > mz_now()
      GROUP BY A.antenna_id, A.geojson;
    `);
  }

  poolClient.release();
}

/**
 * Build a custom Postgres insert with a random performance and clients connected
 * @param antennaId Antenna Identifier
 * @returns
 */
function buildEvent(antennaId: number) {
  return {
    antenna_id: antennaId,
    clients_connected: Math.ceil(Math.random() * 100),
    performance: Math.random() * 10,
    updated_at: new Date().getTime(),
  };
}

async function setUpKafka() {
  console.log('Setting up Kafka...');
  const topics = await kafka.admin().listTopics();
  await producer.connect();

  if (!topics.includes(antennasEventsTopicName)) {
    await kafka.admin().createTopics({
      topics: [
        {
          topic: antennasEventsTopicName,
        },
        {
          topic: antennasTopic,
        },
      ],
    });

    producer.send({
      topic: antennasTopic,
      messages: mainAntennas.map((antenna) => ({value: JSON.stringify(antenna)})),
    });

    producer.send({
      topic: antennasTopic,
      messages: helperAntennas.map((antenna) => ({value: JSON.stringify(antenna)})),
    });
  }
}

/**
 * Generate data to Postgres indefinitely
 */
async function dataGenerator() {
  console.log('Generating data...');
  setInterval(() => {
    const events = [1, 2, 3, 4, 5, 6, 7]
      .map((antennaId) => buildEvent(antennaId))
      .map((event) => ({value: JSON.stringify(event)}));

    producer.send({
      topic: antennasEventsTopicName,
      messages: events,
    });
  }, 1000);
}

setUpKafka()
  .then(() => {
    setUpMaterialize()
      .then(() => {
        dataGenerator();
      })
      .catch((err) => {
        console.error(err);
      });
  })
  .catch((kafkaErr) => {
    console.error(kafkaErr);
    process.exit(1);
  });
