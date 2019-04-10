const path = require('path');
const webpack = require('webpack');
const ExtractTextPlugin = require('extract-text-webpack-plugin');

const setting = {
    mode: 'none',
    devtool: 'cheap-source-map',
    target: 'electron-renderer',
    entry: './app/src/renderer/main.js',
    resolve: {
        extensions: ['.js'],
    },
    output: {
        path: path.resolve(__dirname, 'app', 'src', 'renderer', 'dist'),
        filename: '[name].bundle.js',
        hotUpdateChunkFilename: 'hot/hot-update.js',
        hotUpdateMainFilename: 'hot/hot-update.json',
    },
    module: {
        rules: [
            {
                test: /\.(js|jsx|mjs)$/,
                exclude: [
                    /node_modules/,
                    /modal[\\/]app\.js/,
                ],
                use: [{ loader: 'babel-loader' }],
            },
            {
                test: /\.css$/,
                use: ExtractTextPlugin.extract({
                    fallback: 'style-loader',
                    use: 'css-loader',
                }),
            },
            {
                test: /\.(ico|png|jpg|jpeg|gif|svg|woff|woff2|ttf|eot|cur)(\?v=[0-9]\.[0-9]\.[0-9])?$/,
                loader: 'url-loader',
                options: {
                    name: '[hash].[ext]',
                    limit: 10000,
                },
            },
        ],
    },
    plugins: [
        new ExtractTextPlugin('bundle.css'),
        new webpack.HotModuleReplacementPlugin(),
    ],
};

module.exports = setting;
