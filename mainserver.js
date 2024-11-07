const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const xlsx = require('xlsx');
const axios = require('axios');
const Tesseract = require('tesseract.js');
const tf = require('@tensorflow/tfjs');
const { WordNetLemmatizer } = require('wordnet');
const speech = require('@google-cloud/speech');

const app = express();
const PORT = process.env.PORT || 3000;

// API Keys
const COHERE_API_KEY = 'WlAjHTaXW5ElFhvmUNWmcPr97IAiinSuHIqOUOk7';

// Configure CORS and JSON parsing
app.use(cors());
app.use(express.json());

// Configure Google Cloud Speech-to-Text client
const speechClient = new speech.SpeechClient();

// Set up multer for file upload handling
const upload = multer({ dest: 'uploads/' });

// Predefined urgency dictionary for news analysis
const urgencyWords = [
    "immediate", "urgent", "critical", "asap", "important", "crisis", "priority", "emergency", "alert", "risk"
];

// Create embeddings for urgency words
let urgencyEmbeddings = urgencyWords.map(word => tf.util.createShuffledIndices(word.length));

// Predefined hypernym categories for transaction analysis
const hypernymCategories = {
    'food': ['food.n.01', 'meal.n.01', 'snack.n.01', 'drink.n.01', 'dish.n.01', 'fruit.n.01'],
    'social_life': ['recreation.n.01', 'celebration.n.01', 'outing.n.01', 'party.n.01', 'concert.n.01'],
    'transportation': ['vehicle.n.01', 'transportation.n.01', 'taxi.n.01', 'airplane.n.01', 'bus.n.01'],
    'entertainment': ['culture.n.01', 'art.n.01', 'concert.n.01', 'movie.n.01', 'game.n.01'],
    'household': ['household.n.01', 'furniture.n.01', 'appliance.n.01', 'utility.n.01'],
    'shopping': ['clothing.n.01', 'footwear.n.01', 'accessory.n.01', 'cosmetic.n.01'],
    'health': ['health.n.01', 'medicine.n.01', 'therapy.n.01', 'fitness.n.01'],
    'education': ['education.n.01', 'book.n.01', 'course.n.01', 'lecture.n.01'],
    'gift': ['gift.n.01', 'present.n.01', 'souvenir.n.01', 'donation.n.01'],
    'others': ['artifact.n.01', 'object.n.01', 'thing.n.01']
};

// Utility Functions
function cosineSimilarity(vecA, vecB) {
    const dotProduct = tf.tidy(() => tf.sum(tf.mul(vecA, vecB)).arraySync());
    const magnitudeA = tf.tidy(() => Math.sqrt(tf.sum(tf.square(vecA)).arraySync()));
    const magnitudeB = tf.tidy(() => Math.sqrt(tf.sum(tf.square(vecB)).arraySync()));
    return dotProduct / (magnitudeA * magnitudeB);
}

async function isUrgent(description) {
    if (!description) return false;
    const descriptionVector = tf.util.createShuffledIndices(description.length);
    let maxSimilarity = 0;
    for (let urgencyEmbedding of urgencyEmbeddings) {
        const similarity = cosineSimilarity(descriptionVector, urgencyEmbedding);
        if (similarity > maxSimilarity) {
            maxSimilarity = similarity;
        }
    }
    return maxSimilarity >= 0.9;
}

function extractAmountItem(transaction) {
    const tokens = transaction.split(' ');
    const currencyTerms = ['rs', 'rupees', 'bucks', 'dollars', 'pounds', 'cost', 'rupee', 'lakh', 'crore', 'million'];
    const amountPattern = /\b(\d+(?:\.\d+)?)\s*(?:rs|rupees|bucks|dollars|pounds)?/i;
    const amountMatch = amountPattern.exec(transaction);
    const amount = amountMatch ? amountMatch[1] : 'Unknown';
    const itemTokens = tokens.filter(word => !currencyTerms.includes(word.toLowerCase()));
    const item = itemTokens.length > 0 ? itemTokens.join(' ') : 'Unknown';
    return { amount, item };
}

function categorizeItem(item) {
    const lemmatizer = new WordNetLemmatizer();
    const firstWord = item.split(' ')[0];
    const lemmatizedItem = lemmatizer.lemmatize(firstWord.toLowerCase());
    for (const category in hypernymCategories) {
        if (hypernymCategories[category].includes(lemmatizedItem)) {
            return category;
        }
    }
    return 'others';
}

// API Endpoints

// 1. Portfolio Analysis Endpoint
app.post('/analyzePortfolio', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        const filePath = path.join(__dirname, req.file.path);
        let data = [];

        const ext = path.extname(req.file.originalname).toLowerCase();
        if (ext === '.xlsx' || ext === '.xls') {
            const workbook = xlsx.readFile(filePath);
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            data = xlsx.utils.sheet_to_json(sheet);
        } else if (ext === '.csv') {
            const fileContent = fs.readFileSync(filePath, 'utf-8');
            const rows = fileContent.split('\n');
            const headers = rows.shift().split(',');
            rows.forEach(row => {
                if (row.trim()) {
                    const values = row.split(',');
                    const entry = {};
                    headers.forEach((header, index) => {
                        entry[header.trim()] = values[index] ? values[index].trim() : '';
                    });
                    data.push(entry);
                }
            });
        } else {
            return res.status(400).json({ message: 'Unsupported file format. Please upload a CSV or Excel file.' });
        }

        let totalInvestment = 0;
        let totalCurrentValue = 0;
        let investments = [];

        data.forEach(row => {
            const investment = {
                name: row['Stock Name'] || row['Investment Name'],
                amountInvested: parseFloat(row['Investment Amount'] || 0),
                currentValue: parseFloat(row['Current Value'] || 0),
                roi: parseFloat(row['ROI (%)'] || 0)
            };

            totalInvestment += investment.amountInvested;
            totalCurrentValue += investment.currentValue;
            investments.push(investment);
        });

        const overallROI = ((totalCurrentValue - totalInvestment) / totalInvestment) * 100;

        const analysisResult = {
            totalInvestment: totalInvestment.toFixed(2),
            totalCurrentValue: totalCurrentValue.toFixed(2),
            overallROI: overallROI.toFixed(2),
            investments,
            monthlyData: { data: [], layout: {} },
            categoryData: { data: [], layout: {} },
            transactionsOverTime: { data: [], layout: {} }
        };

        fs.unlink(filePath, (err) => {
            if (err) console.error('Error deleting file:', err);
        });

        res.json({ result: analysisResult });
    } catch (error) {
        console.error('Error analyzing the portfolio:', error);
        res.status(500).json({ message: 'Failed to analyze the portfolio', error: error.message });
    }
});

// 2. Cohere API Endpoint
app.post('/coherenceapi', async (req, res) => {
    try {
        const response = await axios.post('https://api.cohere.ai/v1/generate', req.body, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${COHERE_API_KEY}`
            }
        });
        res.json(response.data);
    } catch (error) {
        console.error("Error from Coherence API:", error.response ? error.response.data : error.message);
        res.status(500).json({
            message: 'Failed to fetch data from Coherence API',
            error: error.response ? error.response.data : error.message,
        });
    }
});

// 3. Portfolio Image Processing Endpoint
app.post('/processPortfolioImage', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        const filePath = path.join(__dirname, req.file.path);
        const { data: { text } } = await Tesseract.recognize(filePath, 'eng', {
            logger: m => console.log(m)
        });

        const companyNames = text.match(/\b[A-Z][A-Z]+\b/g) || [];
        const validCompanyNames = companyNames.filter(name => /^[A-Z]{2,}$/.test(name));

        const newsPromises = validCompanyNames.map(async (company) => {
            const today = new Date().toISOString().split('T')[0];
            const lastWeek = new Date();
            lastWeek.setDate(lastWeek.getDate() - 7);
            const lastWeekDate = lastWeek.toISOString().split('T')[0];
            const newsApiUrl = `https://newsapi.org/v2/everything?q=${encodeURIComponent(company + " stock OR finance OR market OR earnings")}&from=${lastWeekDate}&to=${today}&sortBy=publishedAt&apiKey=15a07cabb7774accb4d8b32173f9f586`;
            
            try {
                const newsResponse = await axios.get(newsApiUrl);
                const articles = newsResponse.data.articles.slice(0, 5);
                const articlesWithUrgency = await Promise.all(articles.map(async (article) => ({
                    ...article,
                    urgent: await isUrgent(article.description)
                })));

                return {
                    company,
                    articles: articlesWithUrgency
                };
            } catch (error) {
                console.error(`Error fetching news for ${company}:`, error.message);
                return { company, articles: [] };
            }
        });

        const newsResults = await Promise.all(newsPromises);

        fs.unlink(filePath, (err) => {
            if (err) console.error('Error deleting file:', err);
        });

        const resultWithLinks = newsResults.map(result => ({
            ...result,
            link: `/company/${encodeURIComponent(result.company)}`
        }));

        res.json({ result: resultWithLinks });
    } catch (error) {
        console.error('Error processing the image:', error);
        res.status(500).json({ message: 'Failed to process the image', error: error.message });
    }
});

// 4. Company News Endpoint
app.get('/company/:companyName', async (req, res) => {
    try {
        const companyName = decodeURIComponent(req.params.companyName);
        const page = req.query.page || 1;
        const pageSize = 5;
        const today = new Date().toISOString().split('T')[0];
        const lastWeek = new Date();
        lastWeek.setDate(lastWeek.getDate() - 7);
        const lastWeekDate = lastWeek.toISOString().split('T')[0];
        const newsApiUrl = `https://newsapi.org/v2/everything?q=${encodeURIComponent(companyName + " stock OR finance OR market OR earnings")}&from=${lastWeekDate}&to=${today}&sortBy=publishedAt&pageSize=${pageSize}&page=${page}&apiKey=473368f3df4f4e43ac8aa3c489623464`;
        
        const newsResponse = await axios.get(newsApiUrl);
        const articles = newsResponse.data.articles;
        res.json({ 
            companyName, 
            articles, 
            hasMore: newsResponse.data.totalResults > page * pageSize 
        });
    } catch (error) {
        console.error(`Error fetching news for ${req.params.companyName}:`, error.message);
        res.status(500).json({ message: 'Failed to fetch news articles', error: error.message });
    }
});

// 5. Transaction Analysis Endpoint
app.post('/analyzeTransaction', upload.single('file'), async (req, res) => {
    try {
        console.log("Processing audio input...");

        if (!req.file) {
            return res.status(400).json({ message: 'No audio file uploaded' });
        }

        const filePath = path.join(__dirname, req.file.path);
        const audioBytes = fs.readFileSync(filePath).toString('base64');

        const request = {
            audio: { content: audioBytes },
            config: {
                encoding: 'LINEAR16',
                sampleRateHertz: 16000,
                languageCode: 'en-US',
            },
        };

        const [response] = await speechClient.recognize(request);
        const transcription = response.results
            .map(result => result.alternatives[0].transcript)
            .join(' ');

        console.log(`Transcription: ${transcription}`);

        const amountItem = extractAmountItem(transcription);
        const category = categorizeItem(amountItem.item);
        const timestamp = new Date();

        fs.unlink(filePath, (err) => {
            if (err) console.error('Error deleting file:', err);
        });

        res.json({ 
            amount: amountItem.amount, 
            item: amountItem.item, 
            category, 
            timestamp 
        });
    } catch (error) {
        console.error('Error analyzing transaction:', error);
        res.status(500).json({ message: 'Failed to analyze transaction', error: error.message });
    }
});

// Frontend JavaScript code (only executed if in browser environment)
if (typeof document !== 'undefined') {
    async function analyzePortfolio() {
        const portfolioFile = document.getElementById("portfolioFile").files[0];
        const responseDiv = document.getElementById("response");
        responseDiv.innerHTML = "<p>Loading...</p>";

        if (!portfolioFile) {
            responseDiv.innerHTML = "<p>Please upload a file to analyze.</p>";
            return;
        }

        const formData = new FormData();
        formData.append("file", portfolioFile);

        try {
            const response = await fetch("http://localhost:3000/analyzePortfolio", {
                method: "POST",
                body: formData
            });

            if (!response.ok) {
                if (response.status === 429) {
		    throw new Error("Rate limit exceeded. Please try again later.");
                } else if (response.status === 500) {
                    throw new Error("Internal Server Error. Please check the backend.");
                } else {
                    throw new Error(`Failed to analyze portfolio. Status code: ${response.status}`);
                }
            }

            const responseData = await response.json();
            const { totalInvestment, totalCurrentValue, overallROI, investments, monthlyData, categoryData, transactionsOverTime } = responseData.result;

            const safeValue = (value) => (value !== undefined && value !== null) ? value : "N/A";

            let htmlContent = `
                <p>Total Investment: ${safeValue(totalInvestment)}</p>
                <p>Total Current Value: ${safeValue(totalCurrentValue)}</p>
                <p>Overall ROI: ${safeValue(overallROI)}%</p>
                <table class="investment-table">
                    <thead>
                        <tr>
                            <th>Investment Name</th>
                            <th>Amount Invested</th>
                            <th>Current Value</th>
                            <th>ROI (%)</th>
                        </tr>
                    </thead>
                    <tbody>
            `;

            investments.forEach(investment => {
                htmlContent += `
                    <tr>
                        <td>${safeValue(investment.name)}</td>
                        <td>${safeValue(investment.amountInvested)}</td>
                        <td>${safeValue(investment.currentValue)}</td>
                        <td>${safeValue(investment.roi)}</td>
                    </tr>
                `;
            });

            htmlContent += `</tbody></table>`;

            // Add filter dropdown for transaction type
            htmlContent += `
                <div>
                    <label for="transaction-type">Select Transaction Type:</label>
                    <select id="transaction-type" onchange="filterGraphs()">
                        <option value="All">All</option>
                        <option value="Income">Income</option>
                        <option value="Expense">Expense</option>
                    </select>
                </div>
            `;

            // Add visualizations
            htmlContent += `<div id="transactions-time-series"></div>`;
            Plotly.newPlot('transactions-time-series', transactionsOverTime.data, transactionsOverTime.layout);

            htmlContent += `<div id="category-pie-chart"></div>`;
            Plotly.newPlot('category-pie-chart', categoryData.data, categoryData.layout);

            htmlContent += `<div id="monthly-spending-bar-chart"></div>`;
            Plotly.newPlot('monthly-spending-bar-chart', monthlyData.data, monthlyData.layout);

            responseDiv.innerHTML = htmlContent;
        } catch (error) {
            responseDiv.innerHTML = `<p>An error occurred: ${error.message}</p>`;
        }
    }

    function filterGraphs() {
        const transactionType = document.getElementById("transaction-type").value;
        console.log("Filtering graphs for: ", transactionType);
        // Implement filtering logic here
    }

    // Include Plotly.js for creating visualizations
    const script = document.createElement('script');
    script.src = 'https://cdn.plot.ly/plotly-latest.min.js';
    document.head.appendChild(script);
}

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});