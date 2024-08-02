const express = require('express');
const app = express();
const cors = require('cors'); 
const jwt = require('jsonwebtoken');
const stripe = require('stripe')(process.env.STRIPE_GATEWAY_SK);
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');


const port = process.env.PORT || 5000;

// middleware
app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.iynsonj.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    // await client.connect();

    const menuCollection = client.db("resturentDB").collection("menu");
    const reviewCollection = client.db("resturentDB").collection("review");
    const cartCollection = client.db("resturentDB").collection("cart");
    const userCollection = client.db("resturentDB").collection("users");
    const paymentCollection = client.db("resturentDB").collection("payments");




    // TOKEN RELATED
    app.post('/jwt', (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.ACCESS_JWT_TOKEN, {
        expiresIn: '1h'
      });
      res.send({ token });
    });

    // Middleware to verify token
    const verifyToken = (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).send({ message: 'Forbidden access' });
      }
      const token = authHeader.split(' ')[1];
      jwt.verify(token, process.env.ACCESS_JWT_TOKEN, (err, decoded) => {
        if (err) {
          return res.status(403).send({ message: 'Invalid token' });
        }
        req.decoded = decoded; // Ensure req.decoded is set
        next();
      });
    };

    // Middleware to verify admin
    const verifyTokenAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email: email };
      const user = await userCollection.findOne(query);
      const isAdmin = user?.role === 'admin';
      if (!isAdmin) { // Fix condition to allow admin access
        return res.status(403).send({ message: 'Forbidden access' });
      }
      next();
    };

    // payment intent
    app.post('/create-payment-intent', async (req, res) => {
      try {
        const { price } = req.body;
        const amount = parseInt(price * 100);
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amount,
          currency: 'usd',
          payment_method_types: ['card']
        });
        res.send({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });


    app.get('/payments/:email', verifyToken, async (req, res) => {
      const query = { email: req.params.email }
      if (req.params.email !== req.decoded.email) {
        return res.status(403).send({ message: 'forbidden access' });
      }
      const result = await paymentCollection.find(query).toArray();
      res.send(result);
    })

    app.post('/payments', async (req, res) => {
      const payment = req.body;
      const paymentResult = await paymentCollection.insertOne(payment);

      //  carefully delete each item from the cart
      console.log('payment info', payment);
      const query = {
        _id: {
          $in: payment.cartIds.map(id => new ObjectId(id))
        }
      };

      const deleteResult = await cartCollection.deleteMany(query);

      res.send({ paymentResult, deleteResult });
    })


    // stats or analytics
    app.get('/admin-stats',verifyToken,verifyTokenAdmin, async(req,res)=>{
      const users = await userCollection.estimatedDocumentCount();
      const menuItem = await menuCollection.estimatedDocumentCount();
      const orders = await paymentCollection.estimatedDocumentCount();
// this is not the best way
// const payments = await paymentCollection.find().toArray();
// const revenue = payments.reduce((total,payment)=>total  + payment.price,0)

const result  = await paymentCollection.aggregate([
  {
    $group:{
      _id:null,
      totalRevenue :{
        $sum:'$price',


      }
    }
  }
]).toArray();
const revenue = result.length > 0 ? result[0].totalRevenue : 0 ;

      res.send({
        users,
        menuItem,
        orders,
        revenue

      });
      
    })
    
    // order status
    /**
     * ----------------------------
     *    NON-Efficient Way
     * ------------------------------
     * 1. load all the payments
     * 2. for every menuItemIds (which is an array), go find the item from menu collection
     * 3. for every item in the menu collection that you found from a payment entry (document)
    */


   // using aggregate pipeline
   app.get('/order-stats', verifyToken,verifyTokenAdmin, async(req, res) =>{
    const result = await paymentCollection.aggregate([
      {
        $unwind: '$menuItemIds'
      },
      {
        $lookup: {
          from: 'menu',
          localField: 'menuItemIds',
          foreignField: '_id',
          as: 'menuItems'
        }
      },
      {
        $unwind: '$menuItems'
      },
      {
        $group: {
          _id: '$menuItems.category',
          quantity:{ $sum: 1 },
          revenue: { $sum: '$menuItems.price'} 
        }
      },
      {
        $project: {
          _id: 0,
          category: '$_id',
          quantity: '$quantity',
          revenue: '$revenue'
        }
      }
    ]).toArray();

    res.send(result);

  })

    // Users related API
    app.get("/users", verifyToken, verifyTokenAdmin, async (req, res) => {
      const result = await userCollection.find().toArray();
      res.send(result);
    });

    app.get("/users/admin/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      if (email !== req.decoded.email) {
        return res.status(403).send({ message: 'Unauthorized access' });
      }

      const query = { email: email };
      const user = await userCollection.findOne(query);
      let admin = false;
      if (user) {
        admin = user.role === 'admin';
      }
      res.send({ admin });
    });

    app.post("/users", async (req, res) => {
      const user = req.body;
      const query = { email: user.email };
      const existingUser = await userCollection.findOne(query);
      if (existingUser) {
        return res.send({ message: "User already exists", insertedId: null });
      }
      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    app.delete("/users/:id", verifyToken, verifyTokenAdmin, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await userCollection.deleteOne(query);
      res.send(result);
    });

    app.patch("/users/admin/:id", verifyToken, verifyTokenAdmin, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updatedDoc = { $set: { role: 'admin' } };
      const result = await userCollection.updateOne(query, updatedDoc);
      res.send(result);
    });

    // Menu related API
    app.post('/menu', verifyToken, verifyTokenAdmin, async (req, res) => {
      const menu = req.body;
      const result = await menuCollection.insertOne(menu);
      res.send(result);
    });

    app.get('/menu', async (req, res) => {
      const result = await menuCollection.find().toArray();
      res.send(result);
    });

    app.get('/menu/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await menuCollection.findOne(query);
      res.send(result);
    });

    app.patch("/menu/:id", async (req, res) => {
      const id = req.params.id;
      const item = req.body;
     const filter= {_id : new ObjectId(id)};
      // const filter = {
      //   _id: ObjectId.isValid(id) ? new ObjectId(id) : null
      // };
  
      // if (!filter._id) {
      //   return res.status(400).send({ error: 'Invalid ID format' });
      // }
      const updateDoc = {
        $set: {
          name: item.name,
          category: item.category,
          price: item.price,
          recipe: item.recipe,
          image: item.image,
        }
      };

      const result = await menuCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    app.delete('/menu/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id : new ObjectId(id)};

      const result = await menuCollection.deleteOne(query);
      res.send(result);
    });

    // Review related API
    app.get('/reviews', async (req, res) => {
      const result = await reviewCollection.find().toArray();
      res.send(result);
    });

    app.post("/cart", verifyToken, async (req, res) => {
      const cartItem = req.body;
      const result = await cartCollection.insertOne(cartItem);
      res.send(result);
    });

    app.get("/cart", verifyToken, async (req, res) => {
      const email = req.query.email;
      const query = { email: email };
      const result = await cartCollection.find(query).toArray();
      res.send(result);
    });

    app.delete("/cart/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await cartCollection.deleteOne(query);
      res.send(result);
    });

    // await client.db("admin").command({ ping: 1 });
    // console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get('/', (req, res) => {
  res.send('Boss is running on the port');
});

app.listen(port, () => {
  console.log(`Restaurant boss is sitting on the port ${port}`);
});
