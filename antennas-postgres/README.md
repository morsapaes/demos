# Manhattan Antennas Performance

https://user-images.githubusercontent.com/11491779/166932582-e5a9fd47-e397-4419-b221-e8f38c6f06f5.mp4

Before trying this out, you will need the following:

- [Materialize account](https://materialize.com/register/).
- A publicly accessible Linux server with [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/) installed.

If you want to try it right now, clone the project on your Linux server and run:

```
cp .env.example .env
```

Then edit the `.env` file and add your Materialize credentials.

Then run:

```bash
# Run `AUTOSETUP=1 docker-compose up` to run steps 2-3 automatically
docker-compose up
```

After a successful build:

```
# Check in your browser
localhost:3000
```

---

## Let’s begin.

An infrastructure working safe and healthy is critical. We, developers, know this very well. In other businesses, like in software, there are vital infrastructures, such as mobile antennas (4G, 5G) in telecommunications companies. <br/>
If there is some issue, it needs to be detected and fixed quickly; otherwise, customers will complain, or even worse, move to the competition (churn rate is serious business).

Antennas manufacturers share [key performance indicators](https://www.ericsson.com/en/reports-and-papers/white-papers/performance-verification-for-5g-nr-deployments) with their telecommunications companies clients. Let's call all these indicators "performance". Rather than setting a 5G antenna manually to provide indicators, let randomness generate this value, providing even more excitement and entertainment to the case than in real life.

Each antenna has a fixed range where is capable of serving clients. In a map, a green, yellow, or red (healthy, semi-healthy, and unhealthy) circle will denote this area.

If the last-half-minute average performance is greater than 5, the antenna is healthy. <br/>
If it is greater than 4.75 but less than 5, it is semi-healthy. <br/>
If it is less than 4.75, the antenna is unhealthy. <br/>

In case an antenna is unhealthy beyond a period of seconds, a whole set of helper antennas will be deployed to improve the performance in the area. After a few seconds of improvement they will be deactivated.

All this information needs to be processed, analyzed, and served, and that's where Materialize will do the work for us efficiently.

## Detailes steps

There are different ways to achieve a result like this one using Materialize, but for this case, the following strategy fulfill our needs:

1.  Postgres, where all the base data resides.
2.  Materialize to process and serve the antenna's performance.
3.  Helper process to generate the antennas random data and initialize Materialize.
4.  Node.js GraphQL API connects to Materialize using [subscribe](https://materialize.com/docs/sql/subscribe/#conceptual-framework).
5.  React front-end displaying the information using GraphQL subscriptions.
6.  Microservice deploying and pushing helper antennas when performance is low.

_Our source, Postgres, could be alternatively replaced with any other [Materialize source](https://materialize.com/docs/sql/create-source/#conceptual-framework)_

![Architecture](https://user-images.githubusercontent.com/11491779/155920578-7984244a-6382-4628-a87b-00e1f6ad1acd.png)

<br/>

1. To begin with, Postgres needs to be up and running. You can reuse this [custom image with SQLs and shell scripts](https://github.com/MaterializeInc/developer-experience/tree/main/mz-playground/postgres-graphql/postgres) that will get executed in [Postgres initialization](https://github.com/docker-library/docs/blob/master/postgres/README.md#initialization-scripts). <br/><br/> The scripts creates the schemas and defines everything we need to use them as a source:

```sql
-- Antennas table will contain the identifier and geojson for each antenna.
CREATE TABLE antennas (
    antenna_id INT GENERATED ALWAYS AS IDENTITY,
    geojson JSON NOT NULL
);


-- Antennas performance table will contain every performance update available
CREATE TABLE antennas_performance (
    antenna_id INT,
    clients_connected INT NOT NULL,
    performance INT NOT NULL,
    updated_at timestamp NOT NULL
);


-- Enable REPLICA for both tables
ALTER TABLE antennas REPLICA IDENTITY FULL;
ALTER TABLE antennas_performance REPLICA IDENTITY FULL;


-- Create publication on the created tables
CREATE PUBLICATION antennas_publication_source FOR TABLE antennas, antennas_performance;


-- Create user and role to be used by Materialize
CREATE ROLE materialize REPLICATION LOGIN PASSWORD 'materialize';
GRANT SELECT ON antennas, antennas_performance TO materialize;
```

<br/>

2-3. Once Postgres is up and running, Materialize will be ready to consume it. If you are automating a deployment, a [helper process](https://github.com/MaterializeInc/developer-experience/blob/main/mz-playground/postgres-graphql/helper/src/app.ts) can do the job to set up sources and views in Materialize and also feed Postgres indefinitely with data.<br/><br/> The SQL script to build Materialize schema is the next one:

```sql
  -- All these queries run inside the helper process.

  -- Create the Postgres secret
  CREATE SECRET IF NOT EXISTS postgres_password AS 'materialize';

   -- Create the Postgres connection
  CREATE CONNECTION pg_connection TO POSTGRES (
    HOST '${process.env.POSTGRES_HOST || 'postgres'}',
    PORT 5432,
    USER 'materialize',
    PASSWORD SECRET postgres_password,
    DATABASE 'postgres'
  );

  -- Create the Postgres Source
  CREATE SOURCE IF NOT EXISTS antennas_publication_source
    FROM POSTGRES CONNECTION pg_connection (PUBLICATION 'antennas_publication_source')
    FOR ALL TABLES
    WITH (SIZE = '3xsmall');

  -- Filter last half minute updates and aggregate by anntena ID and GeoJSON to obtain the average performance in the last half minute.
  CREATE MATERIALIZED VIEW IF NOT EXISTS last_half_minute_performance_per_antenna AS
    SELECT A.antenna_id, A.geojson, AVG(AP.performance) as performance
    FROM antennas A JOIN antennas_performance AP ON (A.antenna_id = AP.antenna_id)
    WHERE (cast("updated_at" as timestamp) + INTERVAL '1 HOUR' ) > mz_now()
    GROUP BY A.antenna_id, A.geojson;
```

Antennas data generation statement:

```sql
  -- Insert data using the helper process.
  INSERT INTO antennas_performance (antenna_id, clients_connected, performance, updated_at) VALUES (
    ${antennaId},
    ${Math.ceil(Math.random() * 100)},
    ${Math.random() * 10},
    now()
  );
```

4. Now, the information should be ready to consume. <br/><br/>
   The back-end works with [Graphql-ws](https://github.com/enisdenjo/graphql-ws). Subscriptions and subscribe go together like Bonnie and Clyde. Multiple applications send ongoing events to the front-end with sockets or server-sent events (SSE), becoming super handy to use with `subscribe`. Rather than constantly sending queries back-and-forth, we can run a single `subscribe last_half_minute_performance_per_antenna with (snapshot)` and send the results more efficiently. <br/><br/>
   The back-end will use a modified client to run the `SUBSCRIBE`. It implements internally [Node.js stream interfaces](https://nodejs.org/api/stream.html) to handle [backpressure](https://github.com/MaterializeInc/developer-experience/blob/main/mz-playground/postgres-graphql/backend/src/MaterializeClient/SubscribeStream/index.ts), create one second batches and group all the changes in one map [(summary)](https://github.com/MaterializeInc/developer-experience/blob/main/mz-playground/postgres-graphql/backend/src/MaterializeClient/TransformStream/index.ts).

5. The front-end doesn't require going deep since it will consist of only one component. Apollo GraphQL subscribes to our back-end, and the antennas information gets displayed in a list and a visual map. The frequency at which the information updates is every one second.

6. The microservice behaves similar to the front-end. Rather than connecting directly to Materialize, it will subscribe to the GraphQL API and subscribe to the antenna's performance. Once a low performance has been detected multiple times a set of helper antennas will be deployed.
